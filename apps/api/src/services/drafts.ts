import type { DraftOrigin, DraftStatus, OutgoingInput, SealedDraft, SealedMessage } from '@inbox-os/shared';
import { audit, type Actor } from '../audit.js';
import { one, query } from '../db/pool.js';
import { HttpError, notFound } from '../errors.js';
import type { OrgCrypto } from '../keyvault.js';
import { canDraft, decideSend, type AgentSettingsRow, type SendDecision } from '../agent/permissions.js';
import { sendViaMailbox } from './send.js';

export interface DraftRow {
  id: string;
  organisation_id: string;
  workspace_id: string;
  mailbox_id: string;
  thread_id: string | null;
  in_reply_to_message_id: string | null;
  status: DraftStatus;
  origin: DraftOrigin;
  category: string | null;
  content_sealed: string;
  approval_reason: string | null;
  created_at: string;
  updated_at: string;
  send_error: string | null;
}

export async function getAgentSettings(workspaceId: string): Promise<AgentSettingsRow & { instructions_sealed: string | null; model: string | null }> {
  const row = await one('SELECT permission_level, auto_send_categories, instructions_sealed, model FROM agent_settings WHERE workspace_id = $1', [workspaceId]);
  return row ?? { permission_level: 'draft', auto_send_categories: [], instructions_sealed: null, model: null };
}

export async function getDraft(orgId: string, draftId: string, workspaceIds?: string[]): Promise<DraftRow> {
  const d = await one<DraftRow>('SELECT * FROM drafts WHERE id = $1 AND organisation_id = $2', [draftId, orgId]);
  if (!d || (workspaceIds && !workspaceIds.includes(d.workspace_id))) throw notFound('Draft');
  return d;
}

export interface CreateDraftInput {
  orgId: string;
  mailboxId: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  sealed: string;
  origin: DraftOrigin;
  category?: string | null;
  actor: Actor;
  workspaceIds?: string[];
}

export async function createDraft(input: CreateDraftInput): Promise<DraftRow> {
  const mb = await one<{ workspace_id: string }>('SELECT workspace_id FROM mailboxes WHERE id = $1 AND organisation_id = $2', [input.mailboxId, input.orgId]);
  if (!mb || (input.workspaceIds && !input.workspaceIds.includes(mb.workspace_id))) throw notFound('Mailbox');
  if (input.origin !== 'user') {
    const s = await getAgentSettings(mb.workspace_id);
    if (!canDraft(s.permission_level)) throw new HttpError(403, 'Agent is read-only in this workspace', 'permission_denied');
  }
  if (input.threadId) {
    const t = await one('SELECT 1 FROM threads WHERE id = $1 AND mailbox_id = $2', [input.threadId, input.mailboxId]);
    if (!t) throw notFound('Thread');
  }
  if (input.inReplyToMessageId) {
    const m = await one('SELECT 1 FROM messages WHERE id = $1 AND mailbox_id = $2', [input.inReplyToMessageId, input.mailboxId]);
    if (!m) throw notFound('Message');
  }
  const d = await one<DraftRow>(
    `INSERT INTO drafts (organisation_id, workspace_id, mailbox_id, thread_id, in_reply_to_message_id, origin, category, content_sealed, created_by_user_id, created_by_token_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [input.orgId, mb.workspace_id, input.mailboxId, input.threadId ?? null, input.inReplyToMessageId ?? null, input.origin, input.category ?? null, input.sealed,
      input.actor.userId ?? null, input.actor.tokenId ?? null],
  );
  await audit(input.orgId, input.actor, 'draft.create', { workspaceId: mb.workspace_id, targetType: 'draft', targetId: d!.id, metadata: { origin: input.origin, threadId: input.threadId ?? null } });
  return d!;
}

export async function updateDraft(orgId: string, draftId: string, sealed: string, actor: Actor, workspaceIds?: string[]): Promise<DraftRow> {
  const d = await getDraft(orgId, draftId, workspaceIds);
  if (!['draft', 'pending_approval', 'rejected'].includes(d.status)) throw new HttpError(409, `Draft is ${d.status} and can no longer be edited`, 'conflict');
  if (actor.type !== 'user' && d.status === 'pending_approval') throw new HttpError(409, 'Draft is awaiting human approval', 'conflict');
  const next = await one<DraftRow>(
    `UPDATE drafts SET content_sealed = $3, updated_at = now(), status = CASE WHEN status = 'rejected' THEN 'draft' ELSE status END WHERE id = $1 AND organisation_id = $2 RETURNING *`,
    [draftId, orgId, sealed],
  );
  await audit(orgId, actor, 'draft.update', { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id });
  return next!;
}

/** Thread participants from STORED messages (never from model output or the draft itself). */
export async function threadParticipants(crypto: OrgCrypto, threadId: string, selfAddress: string): Promise<string[]> {
  const rows = (await query<{ content_sealed: string }>('SELECT content_sealed FROM messages WHERE thread_id = $1', [threadId])).rows;
  const set = new Set<string>();
  for (const r of rows) {
    const m = await crypto.open<SealedMessage>(r.content_sealed);
    for (const a of [m.fromAddress, ...m.to, ...m.cc]) if (a) set.add(a.toLowerCase());
  }
  set.delete(selfAddress.toLowerCase());
  return [...set];
}

export function draftToOutgoing(d: SealedDraft): OutgoingInput {
  return { to: d.to, cc: d.cc ?? [], bcc: d.bcc ?? [], subject: d.subject, text: d.text, html: d.html ?? null, attachments: [], inReplyTo: d.inReplyTo ?? null, references: d.references ?? [] };
}

export interface SendRequestResult { status: DraftStatus; decision: SendDecision; draftId: string }

/**
 * Agent / MCP send path. Requires decryption capability (unlocked org or MCP token key)
 * because the permission gate inspects recipients and thread participants.
 */
export async function requestAgentSend(orgId: string, draftId: string, crypto: OrgCrypto, actor: Actor, origin: 'agent' | 'mcp', workspaceIds?: string[]): Promise<SendRequestResult> {
  const d = await getDraft(orgId, draftId, workspaceIds);
  if (d.status === 'sent') throw new HttpError(409, 'Draft already sent', 'conflict');
  if (d.status === 'pending_approval') return { status: d.status, decision: { action: 'pending_approval', reason: d.approval_reason ?? 'Awaiting approval' }, draftId };
  const settings = await getAgentSettings(d.workspace_id);
  const content = await crypto.open<SealedDraft>(d.content_sealed);
  const mb = await one<{ email_address: string }>('SELECT email_address FROM mailboxes WHERE id = $1', [d.mailbox_id]);
  let flagged = false;
  let participants: string[] = [];
  if (d.thread_id) {
    const t = await one<{ injection_flagged: boolean }>('SELECT injection_flagged FROM threads WHERE id = $1', [d.thread_id]);
    flagged = !!t?.injection_flagged;
    participants = await threadParticipants(crypto, d.thread_id, mb!.email_address);
  }
  const decision = decideSend({
    origin, settings, category: d.category, injectionFlagged: flagged,
    recipients: [...content.to, ...(content.cc ?? []), ...(content.bcc ?? [])],
    threadParticipants: participants, isReply: !!d.thread_id,
  });

  if (decision.action === 'deny') {
    await audit(orgId, actor, 'draft.send_denied', { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id, metadata: { reason: decision.reason } });
    return { status: d.status, decision, draftId };
  }
  if (decision.action === 'pending_approval') {
    await query(`UPDATE drafts SET status = 'pending_approval', approval_reason = $2, updated_at = now() WHERE id = $1`, [d.id, decision.reason]);
    await audit(orgId, actor, 'draft.submit_for_approval', { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id, metadata: { reason: decision.reason } });
    return { status: 'pending_approval', decision, draftId };
  }
  await performSend(d, draftToOutgoing(content), actor, 'draft.auto_send');
  return { status: 'sent', decision, draftId };
}

async function performSend(d: DraftRow, message: OutgoingInput, actor: Actor, action: string): Promise<void> {
  // Claim atomically so two approvers / retries can't double-send.
  const claimed = await one(`UPDATE drafts SET status = 'approved', updated_at = now() WHERE id = $1 AND status IN ('draft','pending_approval','failed') RETURNING id`, [d.id]);
  if (!claimed) throw new HttpError(409, 'Draft is already being sent', 'conflict');
  try {
    const out = await sendViaMailbox(d.mailbox_id, message);
    await query(`UPDATE drafts SET status = 'sent', sent_at = now(), sent_message_id_hash = $2, send_error = NULL, updated_at = now() WHERE id = $1`, [d.id, out.messageIdHash]);
    await audit(d.organisation_id, actor, action, { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id, metadata: { recipients: message.to.length + message.cc.length + message.bcc.length } });
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200) ?? 'send failed';
    await query(`UPDATE drafts SET status = 'failed', send_error = $2, updated_at = now() WHERE id = $1`, [d.id, msg]);
    await audit(d.organisation_id, actor, 'draft.send_failed', { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id });
    throw new HttpError(502, `Send failed: ${msg}`, 'send_failed');
  }
}

/** A person approves (and may edit) a draft. Plaintext comes from the approver's browser. */
export async function approveAndSend(orgId: string, draftId: string, message: OutgoingInput, userId: string): Promise<void> {
  const d = await getDraft(orgId, draftId);
  if (!['pending_approval', 'draft', 'failed'].includes(d.status)) throw new HttpError(409, `Draft is ${d.status}`, 'conflict');
  await query('UPDATE drafts SET reviewed_by_user_id = $2, reviewed_at = now() WHERE id = $1', [d.id, userId]);
  await performSend(d, message, { type: 'user', userId }, d.origin === 'user' ? 'draft.send' : 'draft.approve_send');
}

export async function rejectDraft(orgId: string, draftId: string, userId: string): Promise<void> {
  const d = await getDraft(orgId, draftId);
  if (d.status !== 'pending_approval') throw new HttpError(409, 'Only drafts awaiting approval can be rejected', 'conflict');
  await query(`UPDATE drafts SET status = 'rejected', reviewed_by_user_id = $2, reviewed_at = now(), updated_at = now() WHERE id = $1`, [d.id, userId]);
  await audit(orgId, { type: 'user', userId }, 'draft.reject', { workspaceId: d.workspace_id, targetType: 'draft', targetId: d.id });
}

export async function listPending(orgId: string, workspaceIds?: string[]): Promise<DraftRow[]> {
  return (await query<DraftRow>(
    `SELECT * FROM drafts WHERE organisation_id = $1 AND status = 'pending_approval' AND ($2::uuid[] IS NULL OR workspace_id = ANY($2::uuid[])) ORDER BY updated_at DESC LIMIT 200`,
    [orgId, workspaceIds ?? null],
  )).rows;
}
