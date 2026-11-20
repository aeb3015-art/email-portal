import { beforeAll, describe, expect, it } from 'vitest';
import { open, type SealedMessage, type SealedThreadSummary } from '@inbox-os/shared';
import { pool } from '../db/pool.js';
import { OrgCrypto } from '../keyvault.js';
import { createOrg, rawEmail, resetDb, type TestOrg } from '../test/helpers.js';
import { loadMailbox } from './credentials.js';
import { syncFolder, type ImapLike } from './sync.js';

class FakeImap implements ImapLike {
  folders: Record<string, { uidValidity: number; msgs: { uid: number; source: Buffer; flags: Set<string> }[] }> = {
    INBOX: { uidValidity: 1, msgs: [] },
    Sent: { uidValidity: 7, msgs: [] },
  };
  current = 'INBOX';
  async connect() {}
  async logout() {}
  async list() { return [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }]; }
  async mailboxOpen(path: string) {
    this.current = path;
    const f = this.folders[path]!;
    return { uidValidity: f.uidValidity, uidNext: (f.msgs.at(-1)?.uid ?? 0) + 1, exists: f.msgs.length };
  }
  async search(q: Record<string, unknown>) {
    const f = this.folders[this.current]!;
    if (typeof q.uid === 'string') {
      const from = Number(q.uid.split(':')[0]);
      return f.msgs.filter((m) => m.uid >= from).map((m) => m.uid);
    }
    return f.msgs.map((m) => m.uid);
  }
  async *fetch(range: number[] | string) {
    const set = new Set(range as number[]);
    for (const m of this.folders[this.current]!.msgs) if (set.has(m.uid)) yield m;
  }
  on() { return this; }
  add(folder: string, uid: number, source: Buffer, seen = false) {
    this.folders[folder]!.msgs.push({ uid, source, flags: new Set(seen ? ['\\Seen'] : []) });
  }
}

let org: TestOrg;
let crypto: OrgCrypto;
const inbox = { path: 'INBOX', label: 'inbox', specialUse: '\\Inbox' };
const sent = { path: 'Sent', label: 'sent', specialUse: '\\Sent' };

beforeAll(async () => {
  await resetDb();
  org = await createOrg();
  crypto = new OrgCrypto(org.orgId, org.publicKey, null); // worker: seal-only
});

describe('sync engine', () => {
  it('backfills, threads by References/In-Reply-To, and stores only sealed content', async () => {
    const imap = new FakeImap();
    const me = org.mailboxAddress;
    imap.add('INBOX', 1, rawEmail({ from: 'Liana <liana@client.test>', to: me, subject: 'Blue Card application', body: 'Secret passport details 123', messageId: 'm1@client.test' }));
    imap.add('Sent', 1, rawEmail({ from: me, to: 'liana@client.test', subject: 'Re: Blue Card application', body: 'Thanks Liana', messageId: 'm2@venture.test', inReplyTo: 'm1@client.test', references: '<m1@client.test>' }), true);
    imap.add('INBOX', 2, rawEmail({ from: 'liana@client.test', to: me, subject: 'Re: Blue Card application', body: 'Here it is', messageId: 'm3@client.test', inReplyTo: 'm2@venture.test', references: '<m1@client.test> <m2@venture.test>' }));
    imap.add('INBOX', 3, rawEmail({ from: 'bob@other.test', to: me, subject: 'Unrelated', body: 'Hello', messageId: 'm4@other.test' }));

    const events: string[] = [];
    const mb = await loadMailbox(org.mailboxId);
    const deps = { onNewMessage: (r: { messageId: string }) => { events.push(r.messageId); } };
    expect(await syncFolder(imap, mb, inbox, crypto, deps)).toBe(3);
    expect(await syncFolder(imap, mb, sent, crypto, deps)).toBe(1);
    expect(events).toHaveLength(0); // backfill never triggers the agent

    const threads = (await pool.query('SELECT id, message_count, unread_count, summary_sealed, labels FROM threads WHERE mailbox_id = $1 ORDER BY message_count DESC', [org.mailboxId])).rows;
    expect(threads).toHaveLength(2);
    expect(threads[0].message_count).toBe(3);
    expect(threads[0].labels.sort()).toEqual(['inbox', 'sent']);
    expect(threads[0].unread_count).toBe(2);

    // Zero-access: nothing readable in the database
    const dump = JSON.stringify((await pool.query('SELECT * FROM messages')).rows) + JSON.stringify(threads);
    for (const s of ['Blue Card', 'passport', 'liana@client.test', 'm1@client.test']) expect(dump).not.toContain(s);

    // ...but the org private key opens it
    const summary = await open<SealedThreadSummary>(threads[0].summary_sealed, org.publicKey, org.privateKey);
    expect(summary.subject).toBe('Re: Blue Card application');
    const first = (await pool.query(`SELECT content_sealed FROM messages WHERE thread_id = $1 ORDER BY sent_at LIMIT 1`, [threads[0].id])).rows[0];
    expect((await open<SealedMessage>(first.content_sealed, org.publicKey, org.privateKey)).text).toContain('passport');
  });

  it('fetches incrementally and reports new inbound mail', async () => {
    const imap = new FakeImap();
    const me = org.mailboxAddress;
    for (const [uid, id] of [[1, 'm1@client.test'], [2, 'm3@client.test'], [3, 'm4@other.test']] as const) imap.add('INBOX', uid, rawEmail({ from: 'x@client.test', to: me, subject: 's', body: 'b', messageId: id }));
    imap.add('INBOX', 4, rawEmail({ from: 'liana@client.test', to: me, subject: 'Re: Blue Card application', body: 'One more', messageId: 'm5@client.test', references: '<m1@client.test>' }));
    const events: string[] = [];
    const mb = await loadMailbox(org.mailboxId);
    expect(await syncFolder(imap, mb, inbox, crypto, { onNewMessage: (r) => { events.push(r.threadId); } })).toBe(1);
    expect(events).toHaveLength(1);
    const t = (await pool.query('SELECT message_count FROM threads WHERE id = $1', [events[0]])).rows[0];
    expect(t.message_count).toBe(4);
    const cursor = (await pool.query(`SELECT last_uid FROM mailbox_folders WHERE mailbox_id = $1 AND path = 'INBOX'`, [org.mailboxId])).rows[0];
    expect(cursor.last_uid).toBe(4);
  });

  it('handles UIDVALIDITY change without duplicating messages', async () => {
    const imap = new FakeImap();
    imap.folders.INBOX!.uidValidity = 99;
    const me = org.mailboxAddress;
    const ids = ['m1@client.test', 'm3@client.test', 'm4@other.test', 'm5@client.test'];
    ids.forEach((id, i) => imap.add('INBOX', 100 + i, rawEmail({ from: 'x@client.test', to: me, subject: 's', body: 'b', messageId: id })));
    const before = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    const mb = await loadMailbox(org.mailboxId);
    expect(await syncFolder(imap, mb, inbox, crypto)).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(before);
    const cursor = (await pool.query(`SELECT last_uid, uid_validity FROM mailbox_folders WHERE mailbox_id = $1 AND path = 'INBOX'`, [org.mailboxId])).rows[0];
    expect(cursor).toEqual({ last_uid: 103, uid_validity: 99 });
  });
});
