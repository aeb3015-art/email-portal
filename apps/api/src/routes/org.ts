import express from 'express';
import { aiKeySchema, apiTokenCreateSchema, inviteSchema, unlockSchema, ROLES } from '@inbox-os/shared';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, query, tx } from '../db/pool.js';
import { forbidden, HttpError, notFound } from '../errors.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { hashAuthKey } from '../auth/sessions.js';
import { lockOrg, unlockOrg, unlockStatus } from '../keyvault.js';
import { auth, h, parse } from './util.js';

export const orgRouter = express.Router();
orgRouter.use(requireAuth());

orgRouter.get('/', h(async (req, res) => {
  const org = await one('SELECT id, name, public_key, created_at FROM organisations WHERE id = $1', [auth(req).orgId]);
  res.json({ ...org, role: auth(req).role, agent: unlockStatus(auth(req).orgId) });
}));

orgRouter.patch('/', requireRole('owner', 'admin'), h(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
  await query('UPDATE organisations SET name = $2 WHERE id = $1', [auth(req).orgId, b.name]);
  res.status(204).end();
}));

// ---------- Members ----------
orgRouter.get('/members', h(async (req, res) => {
  const rows = (await query(`SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organisation_id = $1 ORDER BY m.created_at`, [auth(req).orgId])).rows;
  res.json({ members: rows });
}));

/**
 * Invite: the inviting admin's browser derives keys from a temporary password, wraps the
 * org key for the new member, and shares the temporary password out of band.
 */
orgRouter.post('/members', requireRole('owner', 'admin'), h(async (req, res) => {
  const b = parse(inviteSchema, req.body);
  const orgId = auth(req).orgId;
  const userId = await tx(async (db) => {
    let u = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [b.email], db);
    if (u) {
      throw new HttpError(409, 'This person already has an account. Multi-organisation invites for existing accounts are not supported yet.', 'conflict');
    }
    u = await one<{ id: string }>('INSERT INTO users (email, name, auth_hash, kdf_params) VALUES ($1,$2,$3,$4) RETURNING id', [b.email, b.name, await hashAuthKey(b.authKey), JSON.stringify(b.kdf)], db);
    await db.query('INSERT INTO memberships (organisation_id, user_id, role, wrapped_org_key) VALUES ($1,$2,$3,$4)', [orgId, u!.id, b.role, b.wrappedOrgKey]);
    return u!.id;
  });
  await audit(orgId, { type: 'user', userId: auth(req).userId }, 'member.invite', { targetType: 'user', targetId: userId, metadata: { role: b.role } });
  res.status(201).json({ userId });
}));

orgRouter.patch('/members/:userId', requireRole('owner', 'admin'), h(async (req, res) => {
  const b = parse(z.object({ role: z.enum(ROLES) }), req.body);
  const target = await one<{ role: string }>('SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2', [auth(req).orgId, req.params.userId]);
  if (!target) throw notFound('Member');
  if ((target.role === 'owner' || b.role === 'owner') && auth(req).role !== 'owner') throw forbidden('Only owners can change owner roles');
  if (target.role === 'owner' && b.role !== 'owner') {
    const owners = await one<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE organisation_id = $1 AND role = 'owner'`, [auth(req).orgId]);
    if (owners!.n <= 1) throw new HttpError(409, 'An organisation needs at least one owner', 'conflict');
  }
  await query('UPDATE memberships SET role = $3 WHERE organisation_id = $1 AND user_id = $2', [auth(req).orgId, req.params.userId, b.role]);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'member.role_change', { targetType: 'user', targetId: String(req.params.userId), metadata: { role: b.role } });
  res.status(204).end();
}));

orgRouter.delete('/members/:userId', requireRole('owner', 'admin'), h(async (req, res) => {
  const target = await one<{ role: string }>('SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2', [auth(req).orgId, req.params.userId]);
  if (!target) throw notFound('Member');
  if (target.role === 'owner') throw forbidden('Owners cannot be removed; transfer ownership first');
  await tx(async (db) => {
    await db.query('DELETE FROM memberships WHERE organisation_id = $1 AND user_id = $2', [auth(req).orgId, req.params.userId]);
    await db.query('UPDATE api_tokens SET revoked_at = now() WHERE organisation_id = $1 AND user_id = $2 AND revoked_at IS NULL', [auth(req).orgId, req.params.userId]);
  });
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'member.remove', { targetType: 'user', targetId: String(req.params.userId) });
  res.status(204).end();
}));

// ---------- Agent unlock (org private key held in API memory only) ----------
orgRouter.get('/agent', h(async (req, res) => { res.json(unlockStatus(auth(req).orgId)); }));

orgRouter.post('/agent/unlock', h(async (req, res) => {
  const b = parse(unlockSchema, req.body);
  if (b.organisationId !== auth(req).orgId) throw forbidden();
  const expiresAt = await unlockOrg(b.organisationId, b.privateKey, b.ttlMinutes, auth(req).userId);
  await audit(b.organisationId, { type: 'user', userId: auth(req).userId }, 'agent.unlock', { metadata: { ttlMinutes: b.ttlMinutes } });
  res.json({ unlocked: true, expiresAt });
}));

orgRouter.post('/agent/lock', h(async (req, res) => {
  lockOrg(auth(req).orgId);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'agent.lock');
  res.json({ unlocked: false });
}));

// ---------- AI provider key (sealed client-side) ----------
orgRouter.get('/ai-key', h(async (req, res) => {
  const rows = (await query('SELECT provider, key_hint, updated_at FROM ai_keys WHERE organisation_id = $1', [auth(req).orgId])).rows;
  res.json({ keys: rows });
}));

orgRouter.put('/ai-key', requireRole('owner', 'admin'), h(async (req, res) => {
  const b = parse(aiKeySchema, req.body);
  await query(
    `INSERT INTO ai_keys (organisation_id, provider, key_sealed, key_hint) VALUES ($1,$2,$3,$4)
     ON CONFLICT (organisation_id, provider) DO UPDATE SET key_sealed = EXCLUDED.key_sealed, key_hint = EXCLUDED.key_hint, updated_at = now()`,
    [auth(req).orgId, b.provider, b.sealed, b.hint]);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'ai_key.set', { metadata: { provider: b.provider } });
  res.status(204).end();
}));

orgRouter.delete('/ai-key/:provider', requireRole('owner', 'admin'), h(async (req, res) => {
  await query('DELETE FROM ai_keys WHERE organisation_id = $1 AND provider = $2', [auth(req).orgId, req.params.provider]);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'ai_key.delete');
  res.status(204).end();
}));

// ---------- MCP API tokens ----------
orgRouter.get('/tokens', h(async (req, res) => {
  const rows = (await query(
    `SELECT id, name, token_prefix, workspace_ids, last_used_at, revoked_at, created_at FROM api_tokens WHERE organisation_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
    [auth(req).orgId, auth(req).userId])).rows;
  res.json({ tokens: rows });
}));

orgRouter.post('/tokens', h(async (req, res) => {
  const b = parse(apiTokenCreateSchema, req.body);
  const valid = (await query<{ id: string }>('SELECT id FROM workspaces WHERE organisation_id = $1 AND id = ANY($2::uuid[])', [auth(req).orgId, b.workspaceIds])).rows;
  if (valid.length !== new Set(b.workspaceIds).size) throw notFound('Workspace');
  const row = await one<{ id: string }>(
    `INSERT INTO api_tokens (organisation_id, user_id, name, token_hash, token_prefix, workspace_ids, wrapped_org_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [auth(req).orgId, auth(req).userId, b.name, b.tokenHash, b.tokenPrefix, b.workspaceIds, b.wrappedOrgKey]);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'api_token.create', { targetType: 'api_token', targetId: row!.id, metadata: { workspaces: b.workspaceIds.length } });
  res.status(201).json({ id: row!.id });
}));

orgRouter.delete('/tokens/:id', h(async (req, res) => {
  const isAdmin = ['owner', 'admin'].includes(auth(req).role);
  const r = await query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND organisation_id = $2 AND ($3 OR user_id = $4) AND revoked_at IS NULL',
    [req.params.id, auth(req).orgId, isAdmin, auth(req).userId]);
  if (!r.rowCount) throw notFound('Token');
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'api_token.revoke', { targetType: 'api_token', targetId: String(req.params.id) });
  res.status(204).end();
}));

// ---------- Audit log ----------
orgRouter.get('/audit', requireRole('owner', 'admin'), h(async (req, res) => {
  const q = parse(z.object({ workspaceId: z.string().uuid().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
  const rows = (await query(
    `SELECT a.id, a.workspace_id, a.actor_type, a.actor_user_id, u.email AS actor_email, a.actor_token_id, a.action, a.target_type, a.target_id, a.metadata, a.created_at
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.organisation_id = $1 AND ($2::uuid IS NULL OR a.workspace_id = $2) AND ($3::bigint IS NULL OR a.id < $3)
     ORDER BY a.id DESC LIMIT $4`, [auth(req).orgId, q.workspaceId ?? null, q.before ?? null, q.limit])).rows;
  res.json({ entries: rows });
}));
