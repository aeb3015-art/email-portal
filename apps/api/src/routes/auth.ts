import express from 'express';
import rateLimit from 'express-rate-limit';
import { changePasswordSchema, preloginSchema, recoverSchema, registerSchema, loginSchema, emailAddress } from '@inbox-os/shared';
import { z } from 'zod';
import { audit } from '../audit.js';
import { sha256 } from '../crypto.js';
import { one, query, tx } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { createSession, fakeKdfParams, hashAuthKey, revokeSession, verifyAuthKey } from '../auth/sessions.js';
import { auth, h, parse } from './util.js';

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

export const authRouter = express.Router();
authRouter.use(['/prelogin', '/register', '/login', '/recovery-key', '/recover'], authLimiter);

/** Returns KDF params so the browser can derive authKey/wrapKey. Unknown emails get stable fake params. */
authRouter.post('/prelogin', h(async (req, res) => {
  const { email } = parse(preloginSchema, req.body);
  const u = await one<{ kdf_params: unknown }>('SELECT kdf_params FROM users WHERE email = $1', [email]);
  res.json({ kdf: u?.kdf_params ?? fakeKdfParams(email) });
}));

authRouter.post('/register', h(async (req, res) => {
  const b = parse(registerSchema.extend({ recoveryProof: z.string().max(128), passwordless: z.boolean().optional() }), req.body);
  const authHash = await hashAuthKey(b.authKey);
  const result = await tx(async (db) => {
    const exists = await one('SELECT 1 FROM users WHERE email = $1', [b.email], db);
    if (exists) throw new HttpError(409, 'An account with this email already exists', 'conflict');
    const user = await one<{ id: string }>('INSERT INTO users (email, name, auth_hash, kdf_params, has_password) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.email, b.name, authHash, JSON.stringify(b.kdf), !b.passwordless], db);
    const org = await one<{ id: string }>('INSERT INTO organisations (name, public_key, recovery_wrapped_key, recovery_proof_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [b.organisationName, b.orgPublicKey, b.recoveryWrappedOrgKey, sha256(b.recoveryProof)], db);
    await db.query(`INSERT INTO memberships (organisation_id, user_id, role, wrapped_org_key) VALUES ($1,$2,'owner',$3)`, [org!.id, user!.id, b.wrappedOrgKey]);
    const ws = await one<{ id: string }>(`INSERT INTO workspaces (organisation_id, name) VALUES ($1, 'General') RETURNING id`, [org!.id], db);
    await db.query(`INSERT INTO agent_settings (workspace_id, organisation_id) VALUES ($1,$2)`, [ws!.id, org!.id]);
    return { userId: user!.id, orgId: org!.id };
  });
  await audit(result.orgId, { type: 'user', userId: result.userId }, 'org.create');
  const session = await createSession(result.userId);
  res.status(201).json({ token: session.token, expiresAt: session.expiresAt, userId: result.userId, organisationId: result.orgId });
}));

authRouter.post('/login', h(async (req, res) => {
  const b = parse(loginSchema, req.body);
  const u = await one<{ id: string; auth_hash: string }>('SELECT id, auth_hash FROM users WHERE email = $1 AND has_password', [b.email]);
  // Constant-ish time: always run bcrypt.
  const ok = await verifyAuthKey(b.authKey, u?.auth_hash ?? '$2a$12$CwTycUXWue0Thq9StjUM0uJ8.ZYpA1vZ0vPq9Z0qv5R1J0sR1Z9eO');
  if (!u || !ok) throw new HttpError(401, 'Invalid email or password', 'unauthorized');
  const session = await createSession(u.id);
  res.json({ token: session.token, expiresAt: session.expiresAt, userId: u.id });
}));

authRouter.post('/logout', requireAuth({ org: false }), h(async (req, res) => {
  await revokeSession(auth(req).sessionToken);
  res.status(204).end();
}));

/** Profile + memberships, including each org's public key and this user's wrapped org key. */
authRouter.get('/me', requireAuth({ org: false }), h(async (req, res) => {
  const user = await one('SELECT id, email, name, kdf_params, has_password FROM users WHERE id = $1', [auth(req).userId]);
  const orgs = (await query(
    `SELECT o.id, o.name, o.public_key, m.role, m.wrapped_org_key FROM memberships m JOIN organisations o ON o.id = m.organisation_id WHERE m.user_id = $1 ORDER BY o.created_at`,
    [auth(req).userId])).rows;
  res.json({ user, organisations: orgs });
}));

authRouter.post('/change-password', requireAuth({ org: false }), h(async (req, res) => {
  const b = parse(changePasswordSchema, req.body);
  const userId = auth(req).userId;
  const u = await one<{ auth_hash: string }>('SELECT auth_hash FROM users WHERE id = $1', [userId]);
  if (!u || !(await verifyAuthKey(b.currentAuthKey, u.auth_hash))) throw new HttpError(401, 'Current password is incorrect', 'unauthorized');
  const memberships = (await query<{ organisation_id: string }>('SELECT organisation_id FROM memberships WHERE user_id = $1', [userId])).rows;
  const provided = new Map(b.wrappedOrgKeys.map((w) => [w.organisationId, w.wrappedOrgKey]));
  if (memberships.some((m) => !provided.has(m.organisation_id))) throw new HttpError(400, 'Re-wrapped keys missing for some organisations', 'bad_request');
  const newHash = await hashAuthKey(b.authKey);
  await tx(async (db) => {
    await db.query('UPDATE users SET auth_hash = $2, kdf_params = $3, has_password = true WHERE id = $1', [userId, newHash, JSON.stringify(b.kdf)]);
    for (const m of memberships) await db.query('UPDATE memberships SET wrapped_org_key = $3 WHERE user_id = $1 AND organisation_id = $2', [userId, m.organisation_id, provided.get(m.organisation_id)]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, sha256(auth(req).sessionToken)]);
  });
  for (const m of memberships) await audit(m.organisation_id, { type: 'user', userId }, 'user.change_password');
  res.status(204).end();
}));

/** Step 1 of recovery: prove possession of the recovery key, receive the recovery-wrapped org key. */
authRouter.post('/recovery-key', h(async (req, res) => {
  const b = parse(z.object({ email: emailAddress, recoveryProof: z.string().max(128) }), req.body);
  const row = await one<{ organisation_id: string; recovery_wrapped_key: string; public_key: string }>(
    `SELECT o.id AS organisation_id, o.recovery_wrapped_key, o.public_key FROM users u JOIN memberships m ON m.user_id = u.id AND m.role = 'owner'
     JOIN organisations o ON o.id = m.organisation_id WHERE u.email = $1 AND o.recovery_proof_hash = $2 LIMIT 1`, [b.email, sha256(b.recoveryProof)]);
  if (!row) throw new HttpError(401, 'Recovery key is not valid for this account', 'unauthorized');
  res.json({ organisationId: row.organisation_id, recoveryWrappedKey: row.recovery_wrapped_key, publicKey: row.public_key });
}));

/** Step 2: set a new password. The client has re-wrapped the org key with the new wrap key. */
authRouter.post('/recover', h(async (req, res) => {
  const b = parse(recoverSchema, req.body);
  const row = await one<{ user_id: string; organisation_id: string }>(
    `SELECT u.id AS user_id, o.id AS organisation_id FROM users u JOIN memberships m ON m.user_id = u.id AND m.role = 'owner'
     JOIN organisations o ON o.id = m.organisation_id WHERE u.email = $1 AND o.recovery_proof_hash = $2 LIMIT 1`, [b.email, sha256(b.recoveryProof)]);
  if (!row) throw new HttpError(401, 'Recovery key is not valid for this account', 'unauthorized');
  const newHash = await hashAuthKey(b.authKey);
  await tx(async (db) => {
    await db.query('UPDATE users SET auth_hash = $2, kdf_params = $3 WHERE id = $1', [row.user_id, newHash, JSON.stringify(b.kdf)]);
    await db.query('UPDATE memberships SET wrapped_org_key = $3 WHERE user_id = $1 AND organisation_id = $2', [row.user_id, row.organisation_id, b.wrappedOrgKey]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
  });
  await audit(row.organisation_id, { type: 'user', userId: row.user_id }, 'user.recover_account');
  res.status(204).end();
}));
