import type { ParsedMail, AddressObject } from 'mailparser';
import type { SealedMessage, SealedThreadSummary } from '@inbox-os/shared';
import { one, tx } from '../db/pool.js';
import type { OrgCrypto } from '../keyvault.js';
import { detectInjection } from './injection.js';
import { threadingKeys } from './threading.js';

export interface MailboxContext {
  id: string;
  organisationId: string;
  workspaceId: string;
  emailAddress: string;
}

export interface IngestInput {
  parsed: ParsedMail;
  folder: string;
  label: string;
  uid?: number | null;
  providerMessageId?: string | null;
  isRead: boolean;
  flags?: string[];
}

export interface IngestResult {
  messageId: string;
  threadId: string;
  created: boolean;
  injectionFlagged: boolean;
  isOutbound: boolean;
}

function addresses(a: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.flatMap((x) => x.value).map((v) => ({ address: (v.address ?? '').toLowerCase(), name: v.name ?? '' })).filter((v) => v.address);
}

export function makeSnippet(text: string): string {
  return text.replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Store one message. Plaintext exists only in this function's memory: everything written is
 * either a sealed envelope (org public key) or a hash. The worker cannot read what it stored.
 */
export async function ingestMessage(mb: MailboxContext, input: IngestInput, crypto: OrgCrypto): Promise<IngestResult> {
  const p = input.parsed;
  const from = addresses(p.from)[0] ?? { address: '', name: '' };
  const to = addresses(p.to).map((x) => x.address);
  const cc = addresses(p.cc).map((x) => x.address);
  const subject = p.subject ?? '';
  const text = p.text ?? '';
  const html = typeof p.html === 'string' ? p.html : null;
  const sentAt = p.date && !Number.isNaN(p.date.getTime()) ? p.date : new Date();
  const keys = threadingKeys({
    messageId: p.messageId,
    inReplyTo: typeof p.inReplyTo === 'string' ? p.inReplyTo : null,
    references: p.references ?? null,
    subject,
  });
  const isOutbound = from.address === mb.emailAddress.toLowerCase();
  const injection = detectInjection(subject, text, html);
  const snippet = makeSnippet(text);

  const refsRaw = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const sealedMessage: SealedMessage = {
    messageId: p.messageId ?? null,
    references: refsRaw,
    subject, fromAddress: from.address, fromName: from.name, to, cc, text, html, snippet,
    attachments: p.attachments.map((a) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, size: a.size })),
  };
  const summary: SealedThreadSummary = {
    subject,
    snippet,
    participants: [...new Set([from.address, ...to, ...cc].filter((x) => x && x !== mb.emailAddress.toLowerCase()))].slice(0, 20),
  };
  // Seal before opening the transaction to keep it short.
  const contentSealed = await crypto.seal(sealedMessage);
  const summarySealed = await crypto.seal(summary);
  const attachments = await Promise.all(
    p.attachments.map(async (a) => ({
      meta: await crypto.seal({ filename: a.filename ?? 'attachment', contentType: a.contentType, contentId: a.contentId ?? null }),
      content: await sealAttachment(crypto, a.content),
      size: a.size,
    })),
  );

  return tx(async (db) => {
    // Dedupe: same UID in folder, same provider id, or same Message-ID already in this mailbox
    const existing = await one<{ id: string; thread_id: string }>(
      `SELECT id, thread_id FROM messages WHERE mailbox_id = $1 AND (
         ($2::bigint IS NOT NULL AND folder = $3 AND uid = $2) OR
         ($4::text IS NOT NULL AND provider_message_id = $4) OR
         ($5::text IS NOT NULL AND message_id_hash = $5)
       ) LIMIT 1`,
      [mb.id, input.uid ?? null, input.folder, input.providerMessageId ?? null, keys.messageIdHash],
      db,
    );
    if (existing) {
      await db.query(`UPDATE threads SET labels = array(SELECT DISTINCT unnest(labels || $2::text[])) WHERE id = $1`, [existing.thread_id, [input.label]]);
      return { messageId: existing.id, threadId: existing.thread_id, created: false, injectionFlagged: injection.flagged, isOutbound };
    }

    let threadId: string | null = null;
    if (keys.referencesHashes.length) {
      const r = await one<{ thread_id: string }>(
        `SELECT thread_id FROM messages WHERE mailbox_id = $1 AND message_id_hash = ANY($2::text[]) ORDER BY sent_at DESC LIMIT 1`,
        [mb.id, keys.referencesHashes], db,
      );
      threadId = r?.thread_id ?? null;
    }
    if (!threadId && keys.messageIdHash) {
      const r = await one<{ thread_id: string }>(
        `SELECT thread_id FROM messages WHERE mailbox_id = $1 AND references_hashes @> ARRAY[$2]::text[] LIMIT 1`,
        [mb.id, keys.messageIdHash], db,
      );
      threadId = r?.thread_id ?? null;
    }
    if (!threadId && keys.isReply && keys.subjectHash) {
      const r = await one<{ id: string }>(
        `SELECT id FROM threads WHERE mailbox_id = $1 AND subject_hash = $2 AND last_message_at > $3::timestamptz - interval '30 days'
         ORDER BY last_message_at DESC LIMIT 1`,
        [mb.id, keys.subjectHash, sentAt], db,
      );
      threadId = r?.id ?? null;
    }

    const unread = input.isRead || isOutbound ? 0 : 1;
    if (!threadId) {
      const t = await one<{ id: string }>(
        `INSERT INTO threads (organisation_id, workspace_id, mailbox_id, summary_sealed, subject_hash, labels, message_count, unread_count, last_message_at, injection_flagged)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) RETURNING id`,
        [mb.organisationId, mb.workspaceId, mb.id, summarySealed, keys.subjectHash, [input.label], unread, sentAt, injection.flagged], db,
      );
      threadId = t!.id;
    } else {
      await db.query(
        `UPDATE threads SET
           message_count = message_count + 1,
           unread_count = unread_count + $2,
           labels = array(SELECT DISTINCT unnest(labels || $3::text[])),
           injection_flagged = injection_flagged OR $4,
           summary_sealed = CASE WHEN $5::timestamptz >= last_message_at THEN $6 ELSE summary_sealed END,
           last_message_at = GREATEST(last_message_at, $5::timestamptz)
         WHERE id = $1`,
        [threadId, unread, [input.label], injection.flagged, sentAt, summarySealed],
      );
    }

    const m = await one<{ id: string }>(
      `INSERT INTO messages (organisation_id, workspace_id, mailbox_id, thread_id, folder, uid, provider_message_id,
         message_id_hash, in_reply_to_hash, references_hashes, content_sealed, sent_at, is_read, is_outbound, flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [mb.organisationId, mb.workspaceId, mb.id, threadId, input.folder, input.uid ?? null, input.providerMessageId ?? null,
        keys.messageIdHash, keys.inReplyToHash, keys.referencesHashes, contentSealed, sentAt, input.isRead || isOutbound, isOutbound, input.flags ?? []],
      db,
    );
    for (const a of attachments) {
      await db.query(
        `INSERT INTO attachments (organisation_id, message_id, meta_sealed, size_bytes, content_sealed) VALUES ($1,$2,$3,$4,$5)`,
        [mb.organisationId, m!.id, a.meta, a.size, a.content],
      );
    }
    return { messageId: m!.id, threadId: threadId!, created: true, injectionFlagged: injection.flagged, isOutbound };
  });
}

async function sealAttachment(crypto: OrgCrypto, content: Buffer): Promise<string> {
  const { sealBytes } = await import('@inbox-os/shared');
  return sealBytes(new Uint8Array(content), crypto.publicKey);
}
