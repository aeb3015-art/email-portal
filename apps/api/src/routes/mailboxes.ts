import express from 'express';
import rateLimit from 'express-rate-limit';
import { imapConfigSchema, mailboxCreateSchema, mailboxUpdateSchema, quickConnectSchema } from '@inbox-os/shared';
import { discover } from '../mail/discover.js';
import { audit } from '../audit.js';
import { one, query } from '../db/pool.js';
import { HttpError, notFound } from '../errors.js';
import { assertMailbox, assertWorkspace, requireAuth, requireRole } from '../auth/middleware.js';
import { decryptJson } from '../crypto.js';
import { encryptCredentials, type MailboxCredentials } from '../mail/credentials.js';
import { testConnection } from '../mail/transport.js';
import { hasRedis, publishMailboxChange } from '../queue/index.js';
import { enabledMailboxIds, syncMailboxes } from '../mail/syncOnce.js';
import { auth, h, parse } from './util.js';

export const mailboxRouter = express.Router();
mailboxRouter.use(requireAuth());
const testLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const PUBLIC_COLS = 'id, workspace_id, provider, email_address, display_name, config_public, enabled, sync_state, sync_error, last_synced_at, created_at';

mailboxRouter.get('/', h(async (req, res) => {
  res.json({ mailboxes: (await query(`SELECT ${PUBLIC_COLS} FROM mailboxes WHERE organisation_id = $1 ORDER BY created_at`, [auth(req).orgId])).rows });
}));

/** Test IMAP + SMTP settings without saving anything. */
mailboxRouter.post('/test', testLimiter, h(async (req, res) => {
  const c = parse(imapConfigSchema, req.body);
  const result = await testConnection(c, { kind: 'password', username: c.username, password: c.password });
  res.json(result);
}));

mailboxRouter.post('/', requireRole('owner', 'admin'), testLimiter, h(async (req, res) => {
  const b = parse(mailboxCreateSchema, req.body);
  await assertWorkspace(auth(req).orgId, b.workspaceId);
  const { password, username, ...hosts } = b.config;
  const creds: MailboxCredentials = { kind: 'password', username, password };
  const test = await testConnection(b.config, creds);
  if (!test.imap.ok || !test.smtp.ok) throw new HttpError(422, `Connection test failed: ${test.imap.error ?? test.smtp.error}`, 'connection_failed');
  const exists = await one('SELECT 1 FROM mailboxes WHERE organisation_id = $1 AND email_address = $2', [auth(req).orgId, b.emailAddress]);
  if (exists) throw new HttpError(409, 'This mailbox is already connected', 'conflict');
  const row = await one<{ id: string }>(
    `INSERT INTO mailboxes (organisation_id, workspace_id, provider, email_address, display_name, config_public, credentials_encrypted)
     VALUES ($1,$2,'imap',$3,$4,$5,$6) RETURNING id`,
    [auth(req).orgId, b.workspaceId, b.emailAddress, b.displayName ?? null, JSON.stringify(hosts), encryptCredentials(creds)]);
  await publishMailboxChange(row!.id);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'mailbox.connect', { workspaceId: b.workspaceId, targetType: 'mailbox', targetId: row!.id, metadata: { provider: 'imap', host: hosts.imapHost } });
  res.status(201).json(await one(`SELECT ${PUBLIC_COLS} FROM mailboxes WHERE id = $1`, [row!.id]));
}));

/**
 * One-step connect, like a phone's mail app: email + password (+ provider). The server finds
 * working settings, verifies them, and saves the mailbox.
 */
mailboxRouter.post('/quick', requireRole('owner', 'admin'), testLimiter, h(async (req, res) => {
  const b = parse(quickConnectSchema, req.body);
  await assertWorkspace(auth(req).orgId, b.workspaceId);
  const exists = await one('SELECT 1 FROM mailboxes WHERE organisation_id = $1 AND email_address = $2', [auth(req).orgId, b.emailAddress]);
  if (exists) throw new HttpError(409, 'This mailbox is already connected', 'conflict');
  const found = await discover(b.emailAddress, b.password, b.provider, b.username);
  if (!found.ok) throw new HttpError(422, found.error ?? 'Could not connect', found.authFailed ? 'auth_failed' : 'not_found');
  const creds: MailboxCredentials = { kind: 'password', username: found.username!, password: b.password };
  const row = await one<{ id: string }>(
    `INSERT INTO mailboxes (organisation_id, workspace_id, provider, email_address, display_name, config_public, credentials_encrypted)
     VALUES ($1,$2,'imap',$3,$4,$5,$6) RETURNING id`,
    [auth(req).orgId, b.workspaceId, b.emailAddress, b.displayName ?? null, JSON.stringify({ ...found.hosts, brand: b.provider }), encryptCredentials(creds)]);
  await publishMailboxChange(row!.id);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'mailbox.connect', { workspaceId: b.workspaceId, targetType: 'mailbox', targetId: row!.id, metadata: { provider: b.provider, host: found.hosts!.imapHost } });
  res.status(201).json(await one(`SELECT ${PUBLIC_COLS} FROM mailboxes WHERE id = $1`, [row!.id]));
}));

mailboxRouter.patch('/:id', requireRole('owner', 'admin'), h(async (req, res) => {
  const id = String(req.params.id);
  const mb = await assertMailbox(auth(req).orgId, id);
  const b = parse(mailboxUpdateSchema, req.body);
  if (b.workspaceId) {
    await assertWorkspace(auth(req).orgId, b.workspaceId);
    // Keep denormalised workspace ids in sync for tenant-scoped queries.
    await query('UPDATE threads SET workspace_id = $2 WHERE mailbox_id = $1', [id, b.workspaceId]);
    await query('UPDATE messages SET workspace_id = $2 WHERE mailbox_id = $1', [id, b.workspaceId]);
    await query('UPDATE drafts SET workspace_id = $2 WHERE mailbox_id = $1', [id, b.workspaceId]);
  }
  if (b.config) {
    if (mb.provider !== 'imap') throw new HttpError(400, 'Server settings can only be changed for IMAP mailboxes', 'bad_request');
    const row = await one<{ config_public: Record<string, unknown>; credentials_encrypted: string }>('SELECT config_public, credentials_encrypted FROM mailboxes WHERE id = $1', [id]);
    const cur = decryptJson<{ username: string; password: string }>(row!.credentials_encrypted);
    const { password, username, ...hosts } = b.config;
    const nextHosts = { ...row!.config_public, ...hosts } as any;
    const nextCreds: MailboxCredentials = { kind: 'password', username: username ?? cur.username, password: password ?? cur.password };
    const test = await testConnection(nextHosts, nextCreds);
    if (!test.imap.ok || !test.smtp.ok) throw new HttpError(422, `Connection test failed: ${test.imap.error ?? test.smtp.error}`, 'connection_failed');
    await query('UPDATE mailboxes SET config_public = $2, credentials_encrypted = $3, sync_error = NULL WHERE id = $1', [id, JSON.stringify(nextHosts), encryptCredentials(nextCreds)]);
  }
  await query('UPDATE mailboxes SET display_name = coalesce($2, display_name), workspace_id = coalesce($3, workspace_id), enabled = coalesce($4, enabled) WHERE id = $1',
    [id, b.displayName ?? null, b.workspaceId ?? null, b.enabled ?? null]);
  await publishMailboxChange(id);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'mailbox.update', { workspaceId: b.workspaceId ?? mb.workspace_id, targetType: 'mailbox', targetId: id });
  res.json(await one(`SELECT ${PUBLIC_COLS} FROM mailboxes WHERE id = $1`, [id]));
}));

/** Sync now. With a worker running this is a nudge; without one (serverless) it does the sync inline. */
mailboxRouter.post('/sync', h(async (req, res) => {
  if (hasRedis()) return res.json({ mode: 'worker', results: [] });
  const ids = await enabledMailboxIds(auth(req).orgId);
  const results = await syncMailboxes(ids, { deadline: Date.now() + 50_000, minIntervalMs: 45_000 });
  res.json({ mode: 'inline', results });
}));

mailboxRouter.post('/:id/resync', requireRole('owner', 'admin'), h(async (req, res) => {
  const id = String(req.params.id);
  await assertMailbox(auth(req).orgId, id);
  await publishMailboxChange(id);
  res.status(202).json({ queued: true });
}));

mailboxRouter.delete('/:id', requireRole('owner', 'admin'), h(async (req, res) => {
  const id = String(req.params.id);
  const mb = await assertMailbox(auth(req).orgId, id);
  const r = await query('DELETE FROM mailboxes WHERE id = $1 AND organisation_id = $2', [id, auth(req).orgId]);
  if (!r.rowCount) throw notFound('Mailbox');
  await publishMailboxChange(id);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'mailbox.delete', { workspaceId: mb.workspace_id, metadata: { mailboxId: id } });
  res.status(204).end();
}));
