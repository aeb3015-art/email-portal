import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { OrgCrypto, orgPublicKey } from '../keyvault.js';
import { logger } from '../logger.js';
import { getCredentials, loadMailbox, type MailboxRow } from './credentials.js';
import { ingestMessage, type IngestResult, type MailboxContext } from './ingest.js';
import { friendlyError, hostsFor, imapClient } from './transport.js';

/** The subset of ImapFlow the engine uses; lets tests substitute a fake server. */
export interface ImapLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string; flags?: Set<string> }[]>;
  mailboxOpen(path: string): Promise<{ uidValidity: bigint | number; uidNext: number; exists: number }>;
  search(q: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false>;
  fetch(range: string | number[], q: { uid: true; source: true; flags: true }, opts: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer; flags?: Set<string> }>;
  idle?(): Promise<boolean>;
  on(event: string, cb: (...args: any[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
  usable?: boolean;
}

export interface FolderPlan { path: string; label: string; specialUse: string | null }

export function planFolders(list: { path: string; specialUse?: string }[]): FolderPlan[] {
  const plans: FolderPlan[] = [];
  const inbox = list.find((f) => f.path.toUpperCase() === 'INBOX' || f.specialUse === '\\Inbox');
  if (inbox) plans.push({ path: inbox.path, label: 'inbox', specialUse: '\\Inbox' });
  const sent = list.find((f) => f.specialUse === '\\Sent') ?? list.find((f) => /^(inbox[./])?sent( (items|mail|messages))?$/i.test(f.path));
  if (sent) plans.push({ path: sent.path, label: 'sent', specialUse: '\\Sent' });
  return plans;
}

export type OnNewMessage = (r: IngestResult & { mailboxId: string; organisationId: string; workspaceId: string; folderLabel: string }) => Promise<void> | void;

export interface SyncDeps {
  connect?: (mb: MailboxRow) => Promise<ImapLike>;
  onNewMessage?: OnNewMessage;
  backfillDays?: number;
  backfillMax?: number;
}

/** Sync a single folder: handles UIDVALIDITY resets, initial backfill and incremental fetch. */
export async function syncFolder(client: ImapLike, mb: MailboxRow, plan: FolderPlan, crypto: OrgCrypto, deps: SyncDeps = {}): Promise<number> {
  const box = await client.mailboxOpen(plan.path);
  const uidValidity = Number(box.uidValidity);
  let state = await one<{ id: string; uid_validity: number | null; last_uid: number }>(
    'SELECT id, uid_validity, last_uid FROM mailbox_folders WHERE mailbox_id = $1 AND path = $2', [mb.id, plan.path],
  );
  if (!state) {
    state = await one('INSERT INTO mailbox_folders (mailbox_id, path, special_use, uid_validity, last_uid) VALUES ($1,$2,$3,$4,0) RETURNING id, uid_validity, last_uid',
      [mb.id, plan.path, plan.specialUse, uidValidity]);
  }
  let lastUid = state!.last_uid;
  if (state!.uid_validity !== null && state!.uid_validity !== uidValidity) {
    // Server renumbered the folder: old UIDs are meaningless. Re-scan; Message-ID dedupe prevents duplicates.
    logger.warn({ mailboxId: mb.id, folder: plan.path }, 'UIDVALIDITY changed, resetting folder cursor');
    await query('UPDATE messages SET uid = NULL WHERE mailbox_id = $1 AND folder = $2', [mb.id, plan.path]);
    lastUid = 0;
  }

  let uids: number[];
  if (lastUid === 0) {
    const since = new Date(Date.now() - (deps.backfillDays ?? config.SYNC_BACKFILL_DAYS) * 86400_000);
    const found = (await client.search({ since }, { uid: true })) || [];
    uids = found.sort((a, b) => a - b).slice(-(deps.backfillMax ?? config.SYNC_BACKFILL_MAX));
  } else {
    if (box.uidNext && box.uidNext <= lastUid + 1) uids = [];
    else uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > lastUid);
  }

  const ctx: MailboxContext = { id: mb.id, organisationId: mb.organisation_id, workspaceId: mb.workspace_id, emailAddress: mb.email_address };
  let count = 0;
  let maxUid = lastUid;
  const isBackfill = lastUid === 0;
  for (let i = 0; i < uids.length; i += 50) {
    const batch = uids.slice(i, i + 50);
    for await (const msg of client.fetch(batch, { uid: true, source: true, flags: true }, { uid: true })) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
      const flags = [...(msg.flags ?? [])];
      const res = await ingestMessage(ctx, { parsed, folder: plan.path, label: plan.label, uid: msg.uid, isRead: flags.includes('\\Seen'), flags }, crypto);
      maxUid = Math.max(maxUid, msg.uid);
      if (res.created) {
        count++;
        // Agent triggers only for genuinely new inbound mail, never for the backfill.
        if (!isBackfill && plan.label === 'inbox' && !res.isOutbound && deps.onNewMessage) {
          await deps.onNewMessage({ ...res, mailboxId: mb.id, organisationId: mb.organisation_id, workspaceId: mb.workspace_id, folderLabel: plan.label });
        }
      }
    }
    await query('UPDATE mailbox_folders SET last_uid = $3, uid_validity = $4, updated_at = now() WHERE mailbox_id = $1 AND path = $2', [mb.id, plan.path, maxUid, uidValidity]);
  }
  await query('UPDATE mailbox_folders SET uid_validity = $3, last_uid = GREATEST(last_uid, $4), updated_at = now() WHERE mailbox_id = $1 AND path = $2', [mb.id, plan.path, uidValidity, maxUid]);
  return count;
}

async function setState(mailboxId: string, state: string, error: string | null = null) {
  await query(
    `UPDATE mailboxes SET sync_state = $2, sync_error = $3, last_synced_at = CASE WHEN $2 = 'idle' THEN now() ELSE last_synced_at END WHERE id = $1`,
    [mailboxId, state, error],
  );
}

export function backoffMs(attempt: number): number {
  const base = Math.min(5 * 60_000, 2_000 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * Long-running per-mailbox worker: connect, sync INBOX + Sent, then IMAP IDLE on INBOX
 * for real-time delivery. Sent is re-polled periodically. Reconnects with jittered backoff.
 */
export class MailboxSyncer {
  private stopped = false;
  private client: ImapLike | null = null;
  private attempt = 0;
  private wake: (() => void) | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;

  constructor(public mailboxId: string, private deps: SyncDeps = {}) {}

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.session();
        this.attempt = 0;
      } catch (err) {
        if (this.stopped) break;
        const msg = friendlyError(err);
        logger.warn({ mailboxId: this.mailboxId, err: msg }, 'mailbox sync error');
        await setState(this.mailboxId, 'error', msg).catch(() => undefined);
        const isAuth = /Authentication failed/.test(msg);
        await this.sleep(isAuth ? 15 * 60_000 : backoffMs(this.attempt++));
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
    this.client?.logout().catch(() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => resolve();
      this.sleepTimer = setTimeout(resolve, ms);
    }).then(() => {
      if (this.sleepTimer) clearTimeout(this.sleepTimer);
      this.wake = null;
    });
  }

  private async session(): Promise<void> {
    const mb = await loadMailbox(this.mailboxId);
    if (!mb.enabled) {
      await setState(mb.id, 'disabled');
      this.stopped = true;
      return;
    }
    const crypto = new OrgCrypto(mb.organisation_id, await orgPublicKey(mb.organisation_id), null); // seal-only
    const client = this.deps.connect ? await this.deps.connect(mb) : (imapClient(hostsFor(mb), await getCredentials(mb)) as unknown as ImapLike);
    this.client = client;
    if (!this.deps.connect) await client.connect();

    let closed = false;
    let newMail = false;
    client.on('close', () => { closed = true; this.wake?.(); });
    client.on('error', () => { closed = true; this.wake?.(); });
    client.on('exists', () => { newMail = true; this.wake?.(); });

    try {
      await setState(mb.id, 'syncing');
      const plans = planFolders(await client.list());
      for (const plan of plans) await syncFolder(client, mb, plan, crypto, this.deps);
      await setState(mb.id, 'idle');
      const inbox = plans.find((p) => p.label === 'inbox');
      if (!inbox) throw new Error('No INBOX folder found');
      await client.mailboxOpen(inbox.path);

      let lastFull = Date.now();
      // ImapFlow enters IDLE automatically when the connection is otherwise quiet.
      while (!this.stopped && !closed) {
        await this.sleep(60_000);
        if (this.stopped || closed) break;
        const full = Date.now() - lastFull > 5 * 60_000;
        if (newMail || full) {
          newMail = false;
          for (const plan of full ? plans : [inbox]) await syncFolder(client, mb, plan, crypto, this.deps);
          if (full) lastFull = Date.now();
          await client.mailboxOpen(inbox.path);
          await setState(mb.id, 'idle');
          // Re-check enabled / credential changes on each cycle
          const fresh = await loadMailbox(mb.id);
          if (!fresh.enabled || fresh.credentials_encrypted !== mb.credentials_encrypted) break;
        }
      }
    } finally {
      client.removeAllListeners?.();
      await client.logout().catch(() => undefined);
      this.client = null;
    }
    if (closed && !this.stopped) throw Object.assign(new Error('Connection closed by server'), { code: 'ESOCKET' });
  }
}
