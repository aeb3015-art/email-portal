import express from 'express';
import rateLimit from 'express-rate-limit';
import { fromB64, publicKeyFromPrivate, draftCreateSchema, draftUpdateSchema, outgoingSchema, sendSchema, threadListQuerySchema, voiceDraftSchema } from '@inbox-os/shared';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, query } from '../db/pool.js';
import { HttpError, notFound } from '../errors.js';
import { assertMailbox, requireAuth } from '../auth/middleware.js';
import { OrgCrypto, orgCrypto } from '../keyvault.js';
import { draftReply } from '../agent/drafter.js';
import { approveAndSend, createDraft, getDraft, listPending, rejectDraft, updateDraft } from '../services/drafts.js';
import { sendViaMailbox } from '../services/send.js';
import { getTranscriber } from '../transcription/index.js';
import { auth, h, parse } from './util.js';

export const inboxRouter = express.Router();
inboxRouter.use(requireAuth());

const sendLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.auth?.userId ?? req.ip ?? 'anon' });

/**
 * All content in responses is sealed; the browser decrypts with the org private key.
 * Only routing metadata (ids, timestamps, counts, folder labels) is in clear.
 */
inboxRouter.get('/threads', h(async (req, res) => {
  const q = parse(threadListQuerySchema, req.query);
  const rows = (await query(
    `SELECT t.id, t.workspace_id, t.mailbox_id, t.summary_sealed, t.labels, t.message_count, t.unread_count, t.last_message_at, t.injection_flagged,
       EXISTS (SELECT 1 FROM drafts d WHERE d.thread_id = t.id AND d.status = 'pending_approval') AS has_pending
     FROM threads t
     WHERE t.organisation_id = $1 AND ($2::uuid IS NULL OR t.workspace_id = $2) AND ($3::uuid IS NULL OR t.mailbox_id = $3)
       AND ($4::text IS NULL OR $4 = ANY(t.labels)) AND (NOT $5 OR t.unread_count > 0)
       AND ($6::timestamptz IS NULL OR t.last_message_at < $6)
       AND NOT ('trash' = ANY(t.labels)) AND (CASE WHEN $4::text IS NULL THEN NOT ('archived' = ANY(t.labels)) ELSE true END)
     ORDER BY t.last_message_at DESC LIMIT $7`,
    [auth(req).orgId, q.workspaceId ?? null, q.mailboxId ?? null, q.label ?? null, !!q.unread, q.before ?? null, q.limit])).rows;
  res.json({ threads: rows });
}));

inboxRouter.get('/threads/:id', h(async (req, res) => {
  const t = await one('SELECT id, workspace_id, mailbox_id, summary_sealed, labels, message_count, unread_count, last_message_at, injection_flagged FROM threads WHERE id = $1 AND organisation_id = $2', [req.params.id, auth(req).orgId]);
  if (!t) throw notFound('Thread');
  const messages = (await query(
    `SELECT m.id, m.content_sealed, m.sent_at, m.is_read, m.is_outbound, m.folder,
       coalesce(json_agg(json_build_object('id', a.id, 'meta_sealed', a.meta_sealed, 'size', a.size_bytes)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM messages m LEFT JOIN attachments a ON a.message_id = m.id WHERE m.thread_id = $1 GROUP BY m.id ORDER BY m.sent_at ASC`, [t.id])).rows;
  const drafts = (await query(`SELECT id, status, origin, category, content_sealed, approval_reason, send_error, updated_at FROM drafts WHERE thread_id = $1 AND status <> 'sent' ORDER BY created_at`, [t.id])).rows;
  res.json({ thread: t, messages, drafts });
}));

inboxRouter.post('/threads/:id/read', h(async (req, res) => {
  const b = parse(z.object({ read: z.boolean().default(true) }), req.body);
  const t = await one<{ id: string }>('SELECT id FROM threads WHERE id = $1 AND organisation_id = $2', [req.params.id, auth(req).orgId]);
  if (!t) throw notFound('Thread');
  await query('UPDATE messages SET is_read = $2 WHERE thread_id = $1', [t.id, b.read]);
  await query(`UPDATE threads SET unread_count = CASE WHEN $2 THEN 0 ELSE (SELECT count(*) FROM messages WHERE thread_id = $1 AND NOT is_outbound) END WHERE id = $1`, [t.id, b.read]);
  res.status(204).end();
}));

inboxRouter.post('/threads/:id/labels', h(async (req, res) => {
  const b = parse(z.object({ add: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).max(10).default([]), remove: z.array(z.string().max(40)).max(10).default([]) }), req.body);
  const r = await query(
    `UPDATE threads SET labels = array(SELECT DISTINCT x FROM unnest(labels || $3::text[]) x WHERE NOT x = ANY($4::text[])) WHERE id = $1 AND organisation_id = $2`,
    [req.params.id, auth(req).orgId, b.add, b.remove]);
  if (!r.rowCount) throw notFound('Thread');
  res.status(204).end();
}));

inboxRouter.get('/attachments/:id', h(async (req, res) => {
  const a = await one('SELECT id, meta_sealed, content_sealed, size_bytes FROM attachments WHERE id = $1 AND organisation_id = $2', [req.params.id, auth(req).orgId]);
  if (!a) throw notFound('Attachment');
  res.set('Cache-Control', 'no-store').json(a);
}));

// ---------- Send (compose / reply / forward) ----------
inboxRouter.post('/send', sendLimiter, h(async (req, res) => {
  const b = parse(sendSchema, req.body);
  const mb = await assertMailbox(auth(req).orgId, b.mailboxId);
  const actor = { type: 'user' as const, userId: auth(req).userId };
  if (b.draftId) {
    await approveAndSend(auth(req).orgId, b.draftId, b.message, auth(req).userId);
    return res.json({ status: 'sent', draftId: b.draftId });
  }
  const out = await sendViaMailbox(b.mailboxId, b.message);
  await audit(auth(req).orgId, actor, 'message.send', { workspaceId: mb.workspace_id, targetType: 'thread', targetId: out.ingest?.threadId ?? null, metadata: { recipients: b.message.to.length + b.message.cc.length + b.message.bcc.length } });
  res.json({ status: 'sent', threadId: out.ingest?.threadId ?? null });
}));

// ---------- Drafts ----------
inboxRouter.post('/drafts', h(async (req, res) => {
  const b = parse(draftCreateSchema, req.body);
  const d = await createDraft({ orgId: auth(req).orgId, mailboxId: b.mailboxId, threadId: b.threadId, inReplyToMessageId: b.inReplyToMessageId, sealed: b.sealed, origin: 'user', actor: { type: 'user', userId: auth(req).userId } });
  res.status(201).json({ id: d.id, status: d.status });
}));

inboxRouter.get('/drafts/:id', h(async (req, res) => {
  res.json(await getDraft(auth(req).orgId, String(req.params.id)));
}));

inboxRouter.put('/drafts/:id', h(async (req, res) => {
  const b = parse(draftUpdateSchema, req.body);
  const d = await updateDraft(auth(req).orgId, String(req.params.id), b.sealed, { type: 'user', userId: auth(req).userId });
  res.json({ id: d.id, status: d.status });
}));

inboxRouter.delete('/drafts/:id', h(async (req, res) => {
  const d = await getDraft(auth(req).orgId, String(req.params.id));
  if (d.status === 'sent') throw new HttpError(409, 'Sent drafts cannot be deleted', 'conflict');
  await query('DELETE FROM drafts WHERE id = $1', [d.id]);
  await audit(auth(req).orgId, { type: 'user', userId: auth(req).userId }, 'draft.delete', { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id });
  res.status(204).end();
}));

// ---------- Approval queue ----------
inboxRouter.get('/approvals', h(async (req, res) => {
  const q = parse(z.object({ workspaceId: z.string().uuid().optional() }), req.query);
  const rows = await listPending(auth(req).orgId, q.workspaceId ? [q.workspaceId] : undefined);
  res.json({ drafts: rows });
}));

/** Approver's browser decrypts the draft, optionally edits, and sends plaintext over TLS to send. */
inboxRouter.post('/approvals/:id/approve', sendLimiter, h(async (req, res) => {
  const b = parse(z.object({ message: outgoingSchema }), req.body);
  await approveAndSend(auth(req).orgId, String(req.params.id), b.message, auth(req).userId);
  res.json({ status: 'sent' });
}));

inboxRouter.post('/approvals/:id/reject', h(async (req, res) => {
  await rejectDraft(auth(req).orgId, String(req.params.id), auth(req).userId);
  res.json({ status: 'rejected' });
}));

// ---------- Agent: voice/instruction to draft (requires unlocked org) ----------
const agentLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.auth?.orgId ?? req.ip ?? 'anon' });

inboxRouter.post('/agent/draft', agentLimiter, h(async (req, res) => {
  const b = parse(voiceDraftSchema, req.body);
  let crypto = await orgCrypto(auth(req).orgId);
  if (!crypto.canDecrypt && b.privateKey) {
    // Stateless hosts can't keep an unlocked key in memory, so the browser may lend it for this one request.
    const key = await fromB64(b.privateKey);
    if ((await publicKeyFromPrivate(key)) !== crypto.publicKey) throw new HttpError(403, 'Key does not match this organisation', 'forbidden');
    crypto = new OrgCrypto(auth(req).orgId, crypto.publicKey, key);
  }
  const r = await draftReply({ orgId: auth(req).orgId, threadId: b.threadId, instruction: b.instruction, crypto, actor: { type: 'agent', userId: auth(req).userId }, origin: 'agent' });
  res.status(201).json(r);
}));

inboxRouter.post('/voice/transcribe', agentLimiter, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }), h(async (req, res) => {
  const t = getTranscriber();
  if (!t) throw new HttpError(501, 'Server transcription is not configured; use browser speech recognition', 'not_configured');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Audio body required', 'bad_request');
  const lang = typeof req.query.lang === 'string' ? req.query.lang.slice(0, 10) : undefined;
  const text = await t.transcribe(req.body, String(req.headers['content-type'] ?? 'audio/webm'), lang);
  res.json({ text });
}));
