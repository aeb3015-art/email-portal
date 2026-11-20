import { sha256 } from '../crypto.js';

/** Normalise a Message-ID-style header value: strip angle brackets/whitespace, lowercase. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(/<([^>]+)>/);
  const id = (m ? m[1] : value.trim()).trim().toLowerCase();
  return id.length ? id : null;
}

export function parseReferences(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(' ') : value;
  const ids = raw.match(/<[^>]+>/g) ?? raw.split(/\s+/);
  return ids.map(normalizeMessageId).filter((v): v is string => !!v);
}

const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|r)(\[\d+\])?\s*:\s*)+/i;

export function hasReplyPrefix(subject: string): boolean {
  return PREFIX.test(subject);
}

export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '').replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Hashes used for threading so headers never sit in the database in clear text. */
export const hashId = (id: string) => sha256(`msgid:${id}`);
export const hashSubject = (subject: string) => (normalizeSubject(subject) ? sha256(`subj:${normalizeSubject(subject)}`) : '');

export interface ThreadingKeys {
  messageIdHash: string | null;
  inReplyToHash: string | null;
  referencesHashes: string[];
  subjectHash: string;
  isReply: boolean;
}

export function threadingKeys(h: { messageId?: string | null; inReplyTo?: string | null; references?: string | string[] | null; subject?: string | null }): ThreadingKeys {
  const mid = normalizeMessageId(h.messageId ?? null);
  const irt = normalizeMessageId(h.inReplyTo ?? null);
  const refs = parseReferences(h.references ?? null);
  if (irt && !refs.includes(irt)) refs.push(irt);
  return {
    messageIdHash: mid ? hashId(mid) : null,
    inReplyToHash: irt ? hashId(irt) : null,
    referencesHashes: refs.map(hashId),
    subjectHash: hashSubject(h.subject ?? ''),
    isReply: !!irt || refs.length > 0 || hasReplyPrefix(h.subject ?? ''),
  };
}

/**
 * Candidate lookup order for an incoming message:
 *   1. any known message whose Message-ID is in our References / In-Reply-To (newest reference first)
 *   2. any known message that references OUR Message-ID (a reply arrived before its parent)
 *   3. subject fallback, only when the message looks like a reply and within 30 days
 */
export function lookupOrder(k: ThreadingKeys): string[] {
  return [...k.referencesHashes].reverse();
}
