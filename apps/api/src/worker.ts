/**
 * Sync worker process: one long-lived IMAP connection (with IDLE) per enabled mailbox.
 * It holds ONLY organisation public keys, so it can seal incoming mail but cannot read
 * anything it has stored. New inbound mail is announced to the API (which may hold an
 * unlocked key) via a BullMQ job containing IDs only.
 */
import http from 'node:http';
import { pool, query } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './logger.js';
import { MailboxSyncer } from './mail/sync.js';
import { enqueueAgentJob, MAILBOX_CHANNEL, redis } from './queue/index.js';
import { config } from './config.js';

const syncers = new Map<string, MailboxSyncer>();

function start(mailboxId: string) {
  stop(mailboxId);
  const s = new MailboxSyncer(mailboxId, {
    onNewMessage: (r) => enqueueAgentJob({ organisationId: r.organisationId, workspaceId: r.workspaceId, threadId: r.threadId, messageId: r.messageId, mailboxId: r.mailboxId }),
  });
  syncers.set(mailboxId, s);
  s.run().catch((err) => logger.error({ mailboxId, err: (err as Error).message }, 'syncer crashed'))
    .finally(() => { if (syncers.get(mailboxId) === s) syncers.delete(mailboxId); });
}

function stop(mailboxId: string) {
  syncers.get(mailboxId)?.stop();
  syncers.delete(mailboxId);
}

async function reconcile(mailboxId?: string) {
  const rows = (await query<{ id: string; enabled: boolean }>(
    mailboxId ? 'SELECT id, enabled FROM mailboxes WHERE id = $1' : 'SELECT id, enabled FROM mailboxes', mailboxId ? [mailboxId] : [])).rows;
  if (mailboxId && rows.length === 0) return stop(mailboxId);
  for (const r of rows) (r.enabled ? start : stop)(r.id);
}

async function main() {
  await migrate();
  const sub = redis();
  await sub.subscribe(MAILBOX_CHANNEL);
  sub.on('message', (_ch, id) => { reconcile(id).catch((err) => logger.error({ err: (err as Error).message }, 'reconcile failed')); });
  await reconcile();
  // Safety net: pick up anything missed while Redis was unavailable.
  setInterval(() => {
    query<{ id: string }>('SELECT id FROM mailboxes WHERE enabled').then(({ rows }) => {
      for (const r of rows) if (!syncers.has(r.id)) start(r.id);
    }).catch(() => undefined);
  }, 5 * 60_000);

  // Minimal health endpoint for Railway
  http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, role: 'worker', mailboxes: syncers.size }));
  }).listen(Number(process.env.WORKER_HEALTH_PORT ?? config.PORT));
  logger.info({ mailboxes: syncers.size }, 'sync worker started');

  const shutdown = async () => {
    for (const id of [...syncers.keys()]) stop(id);
    await sub.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'worker failed to start');
  process.exit(1);
});
