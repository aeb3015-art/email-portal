import express from 'express';
import { agentSettingsSchema, knowledgeItemSchema, voiceProfileSchema, workspaceCreateSchema, workspaceUpdateSchema } from '@inbox-os/shared';
import { audit } from '../audit.js';
import { one, query, tx } from '../db/pool.js';
import { notFound } from '../errors.js';
import { assertWorkspace, requireAuth, requireRole } from '../auth/middleware.js';
import { publishMailboxChange } from '../queue/index.js';
import { auth, h, parse } from './util.js';

export const workspaceRouter = express.Router();
workspaceRouter.use(requireAuth());

workspaceRouter.get('/', h(async (req, res) => {
  const rows = (await query(
    `SELECT w.id, w.name, w.description, w.created_at, coalesce(a.permission_level, 'draft') AS permission_level,
       (SELECT count(*)::int FROM mailboxes m WHERE m.workspace_id = w.id) AS mailbox_count
     FROM workspaces w LEFT JOIN agent_settings a ON a.workspace_id = w.id WHERE w.organisation_id = $1 ORDER BY w.created_at`, [auth(req).orgId])).rows;
  res.json({ workspaces: rows });
}));

workspaceRouter.post('/', requireRole('owner', 'admin'), h(async (req, res) => {
  const b = parse(workspaceCreateSchema, req.body);
  const ws = await tx(async (db) => {
    const w = await one<{ id: string }>('INSERT INTO workspaces (organisation_id, name, description) VALUES ($1,$2,$3) RETURNING id, name, description', [auth(req).orgId, b.name, b.description ?? null], db);
    await db.query('INSERT INTO agent_settings (workspace_id, organisation_id) VALUES ($1,$2)', [w!.id, auth(req).orgId]);
    return w!;
  });
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'workspace.create', { workspaceId: ws.id });
  res.status(201).json(ws);
}));

workspaceRouter.patch('/:id', requireRole('owner', 'admin'), h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  const b = parse(workspaceUpdateSchema, req.body);
  await query('UPDATE workspaces SET name = coalesce($3, name), description = coalesce($4, description) WHERE id = $1 AND organisation_id = $2', [id, auth(req).orgId, b.name ?? null, b.description ?? null]);
  res.status(204).end();
}));

workspaceRouter.delete('/:id', requireRole('owner'), h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  const mbs = (await query<{ id: string }>('SELECT id FROM mailboxes WHERE workspace_id = $1', [id])).rows;
  await query('DELETE FROM workspaces WHERE id = $1 AND organisation_id = $2', [id, auth(req).orgId]);
  for (const m of mbs) await publishMailboxChange(m.id);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'workspace.delete', { metadata: { workspaceId: id } });
  res.status(204).end();
}));

// ---------- Agent settings ----------
workspaceRouter.get('/:id/agent', h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  const row = await one('SELECT permission_level, auto_send_categories, instructions_sealed, model, updated_at FROM agent_settings WHERE workspace_id = $1', [id]);
  res.json(row ?? { permission_level: 'draft', auto_send_categories: [], instructions_sealed: null, model: null });
}));

workspaceRouter.put('/:id/agent', requireRole('owner', 'admin'), h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  const b = parse(agentSettingsSchema, req.body);
  await query(
    `INSERT INTO agent_settings (workspace_id, organisation_id, permission_level, auto_send_categories, instructions_sealed, model)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id) DO UPDATE SET permission_level = EXCLUDED.permission_level, auto_send_categories = EXCLUDED.auto_send_categories,
       instructions_sealed = coalesce(EXCLUDED.instructions_sealed, agent_settings.instructions_sealed), model = EXCLUDED.model, updated_at = now()`,
    [id, auth(req).orgId, b.permissionLevel, b.autoSendCategories, b.instructionsSealed ?? null, b.model ?? null]);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'agent.settings_update', { workspaceId: id, metadata: { permissionLevel: b.permissionLevel, autoSendCategories: b.autoSendCategories } });
  res.status(204).end();
}));

// ---------- Voice profile (sealed) ----------
workspaceRouter.get('/:id/voice', h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  res.json((await one('SELECT profile_sealed, updated_at FROM voice_profiles WHERE workspace_id = $1', [id])) ?? { profile_sealed: null });
}));

workspaceRouter.put('/:id/voice', h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  const b = parse(voiceProfileSchema, req.body);
  await query(`INSERT INTO voice_profiles (workspace_id, organisation_id, profile_sealed) VALUES ($1,$2,$3)
    ON CONFLICT (workspace_id) DO UPDATE SET profile_sealed = EXCLUDED.profile_sealed, updated_at = now()`, [id, auth(req).orgId, b.sealed]);
  res.status(204).end();
}));

// ---------- Knowledge base (sealed) ----------
workspaceRouter.get('/:id/knowledge', h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  res.json({ items: (await query('SELECT id, item_sealed, created_at, updated_at FROM knowledge_items WHERE workspace_id = $1 AND organisation_id = $2 ORDER BY updated_at DESC', [id, auth(req).orgId])).rows });
}));

workspaceRouter.post('/:id/knowledge', h(async (req, res) => {
  const id = String(req.params.id);
  await assertWorkspace(auth(req).orgId, id);
  const b = parse(knowledgeItemSchema, req.body);
  res.status(201).json(await one('INSERT INTO knowledge_items (organisation_id, workspace_id, item_sealed) VALUES ($1,$2,$3) RETURNING id', [auth(req).orgId, id, b.sealed]));
}));

workspaceRouter.put('/:id/knowledge/:itemId', h(async (req, res) => {
  const b = parse(knowledgeItemSchema, req.body);
  const r = await query('UPDATE knowledge_items SET item_sealed = $4, updated_at = now() WHERE id = $1 AND workspace_id = $2 AND organisation_id = $3', [req.params.itemId, req.params.id, auth(req).orgId, b.sealed]);
  if (!r.rowCount) throw notFound('Knowledge item');
  res.status(204).end();
}));

workspaceRouter.delete('/:id/knowledge/:itemId', h(async (req, res) => {
  const r = await query('DELETE FROM knowledge_items WHERE id = $1 AND workspace_id = $2 AND organisation_id = $3', [req.params.itemId, req.params.id, auth(req).orgId]);
  if (!r.rowCount) throw notFound('Knowledge item');
  res.status(204).end();
}));
