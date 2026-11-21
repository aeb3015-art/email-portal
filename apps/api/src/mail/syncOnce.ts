import { pool, query } from '../db/pool.js';
import { OrgCrypto, orgPublicKey } from '../keyvault.js';
import { logger } from '../logger.js';
import { getCredentials, loadMailbox } from './credentials.js';
import { planFolders, setState, syncFolder, type ImapLike } from './sync.js';
import { friendlyError, hostsFor, imapClient } from './transport.js';

export interface SyncOnceResult { mailboxId: string; status: 'synced' | 'skipped' | 'error'; newMessages: number; error?: string }

/**
 * One connect-sync-disconnect pass for a mailbox. Used where no long-lived worker exists
 * (serverless): triggered while the app is open and by a scheduled job. Like the worker,
 * it holds only the org public key, so it seals mail it cannot read back.
 */
export async function syncMailboxOnce(mailboxId: string, opts: { deadline?: number; minIntervalMs?: number } = {}): Promise<SyncOnceResult> {
  const mb = await loadMailbox(mailboxId);
  if (!mb.enabled) return { mailboxId, status: 'skipped', newMessages: 0 };
  // One pass at a time per mailbox, across all function instances.
  const lock = await pool.connect();
  try {
    const got = (await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`sync:${mailboxId}`])).rows[0].ok;
    if (!got) return { mailboxId, status: 'skipped', newMessages: 0 };
    try {
      const recent = await lock.query(`SELECT 1 FROM mailboxes WHERE id = $1 AND sync_state = 'idle' AND last_synced_at > now() - ($2::int * interval '1 millisecond')`, [mailboxId, opts.minIntervalMs ?? 0]);
      if (recent.rowCount) return { mailboxId, status: 'skipped', newMessages: 0 };
      const crypto = new OrgCrypto(mb.organisation_id, await orgPublicKey(mb.organisation_id), null);
      const client = imapClient(hostsFor(mb), await getCredentials(mb)) as unknown as ImapLike;
      let count = 0;
      try {
        await client.connect();
        await setState(mb.id, 'syncing');
        for (const plan of planFolders(await client.list())) count += await syncFolder(client, mb, plan, crypto, { deadline: opts.deadline, backfillMax: 300 });
        await setState(mb.id, 'idle');
      } finally {
        await client.logout().catch(() => undefined);
      }
      return { mailboxId, status: 'synced', newMessages: count };
    } catch (err) {
      const msg = friendlyError(err);
      logger.warn({ mailboxId, err: msg }, 'on-demand sync failed');
      await setState(mailboxId, 'error', msg).catch(() => undefined);
      return { mailboxId, status: 'error', newMessages: 0, error: msg };
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`sync:${mailboxId}`]).catch(() => undefined);
    }
  } finally {
    lock.release();
  }
}

export async function syncMailboxes(ids: string[], opts: { deadline?: number; minIntervalMs?: number } = {}): Promise<SyncOnceResult[]> {
  const results: SyncOnceResult[] = [];
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      results.push(await syncMailboxOnce(id, opts));
    }
  }));
  return results;
}

export async function enabledMailboxIds(orgId?: string): Promise<string[]> {
  return (await query<{ id: string }>(`SELECT id FROM mailboxes WHERE enabled AND ($1::uuid IS NULL OR organisation_id = $1) ORDER BY last_synced_at NULLS FIRST`, [orgId ?? null])).rows.map((r) => r.id);
}
