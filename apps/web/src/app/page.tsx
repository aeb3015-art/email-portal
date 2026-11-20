'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toB64, type SealedDraft, type SealedMessage, type SealedThreadSummary } from '@inbox-os/shared';
import { Gate } from '@/components/Gate';
import { Composer, type ComposerInit, type Mailbox } from '@/components/Composer';
import { MailBody } from '@/components/MailBody';
import { VoiceButton } from '@/components/VoiceButton';
import { api, ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Workspace { id: string; name: string; permission_level: string }
interface ThreadRow { id: string; workspace_id: string; mailbox_id: string; summary_sealed: string; labels: string[]; message_count: number; unread_count: number; last_message_at: string; injection_flagged: boolean; has_pending: boolean }
interface Thread extends ThreadRow { summary: SealedThreadSummary }
interface MessageRow { id: string; content_sealed: string; sent_at: string; is_outbound: boolean; attachments: { id: string; meta_sealed: string; size: number }[] }
interface DraftRow { id: string; status: string; origin: string; category: string | null; content_sealed: string; approval_reason: string | null; send_error: string | null }

export default function InboxPage() {
  return <Gate><Inbox /></Gate>;
}

function Inbox() {
  const s = useSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [filter, setFilter] = useState<{ workspaceId?: string; mailboxId?: string; label?: string; unread?: boolean }>({ label: 'inbox' });
  const [threads, setThreads] = useState<Thread[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState('');

  const loadThreads = useCallback(async () => {
    const qs = new URLSearchParams();
    if (filter.workspaceId) qs.set('workspaceId', filter.workspaceId);
    if (filter.mailboxId) qs.set('mailboxId', filter.mailboxId);
    if (filter.label) qs.set('label', filter.label);
    if (filter.unread) qs.set('unread', 'true');
    qs.set('limit', '100');
    const r = await api<{ threads: ThreadRow[] }>(`/inbox/threads?${qs}`);
    const dec = await Promise.all(r.threads.map(async (t) => {
      try { return { ...t, summary: await s.open<SealedThreadSummary>(t.summary_sealed) }; }
      catch { return { ...t, summary: { subject: '(unable to decrypt)', snippet: '', participants: [] } }; }
    }));
    setThreads(dec);
  }, [filter, s]);

  useEffect(() => {
    Promise.all([api<{ workspaces: Workspace[] }>('/workspaces'), api<{ mailboxes: Mailbox[] }>('/mailboxes'), api<{ drafts: unknown[] }>('/inbox/approvals')])
      .then(([w, m, p]) => { setWorkspaces(w.workspaces); setMailboxes(m.mailboxes); setPendingCount(p.drafts.length); })
      .catch((e) => setError(e.message));
  }, [s.org?.id]);

  useEffect(() => {
    loadThreads().catch((e) => setError(e.message));
    const t = setInterval(() => loadThreads().catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [loadThreads]);

  // Search runs locally on decrypted data: the server cannot search what it cannot read.
  const visible = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return threads;
    return threads.filter((t) => { const hay = `${t.summary.subject} ${t.summary.snippet} ${t.summary.participants.join(' ')}`.toLowerCase(); return terms.every((x) => hay.includes(x)); });
  }, [threads, search]);

  const nav = (f: typeof filter) => { setFilter(f); setSelected(null); setComposer(null); };

  return (
    <div className="shell">
      <aside className="side">
        <div className="row"><strong className="grow">Inbox OS</strong></div>
        {s.me!.organisations.length > 1 && (
          <select style={{ marginTop: 8 }} value={s.org?.id} onChange={(e) => s.switchOrg(e.target.value)}>
            {s.me!.organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <button className="btn primary" style={{ width: '100%', marginTop: 12, justifyContent: 'center' }} disabled={!mailboxes.length}
          onClick={() => { setSelected(null); setComposer({ mailboxId: filter.mailboxId ?? mailboxes[0]!.id }); }}>Compose</button>
        <h4>Views</h4>
        <a className={`nav ${filter.label === 'inbox' && !filter.unread ? 'active' : ''}`} onClick={() => nav({ ...filter, label: 'inbox', unread: false })}>Inbox</a>
        <a className={`nav ${filter.unread ? 'active' : ''}`} onClick={() => nav({ ...filter, label: 'inbox', unread: true })}>Unread</a>
        <a className={`nav ${filter.label === 'sent' ? 'active' : ''}`} onClick={() => nav({ ...filter, label: 'sent', unread: false })}>Sent</a>
        <a className={`nav ${filter.label === 'archived' ? 'active' : ''}`} onClick={() => nav({ ...filter, label: 'archived', unread: false })}>Archived</a>
        <Link className="nav" href="/approvals">Approvals {pendingCount > 0 && <span className="pill accent">{pendingCount}</span>}</Link>
        <h4>Workspaces</h4>
        <a className={`nav ${!filter.workspaceId && !filter.mailboxId ? 'active' : ''}`} onClick={() => nav({ label: filter.label })}>All workspaces</a>
        {workspaces.map((w) => (
          <div key={w.id}>
            <a className={`nav ${filter.workspaceId === w.id && !filter.mailboxId ? 'active' : ''}`} onClick={() => nav({ label: filter.label, workspaceId: w.id })}>{w.name}</a>
            {mailboxes.filter((m) => m.workspace_id === w.id).map((m) => (
              <a key={m.id} className={`nav small ${filter.mailboxId === m.id ? 'active' : ''}`} style={{ paddingLeft: 20 }} onClick={() => nav({ label: filter.label, mailboxId: m.id })}>
                {m.email_address} {m.sync_state === 'error' && <span className="pill warn" title={m.sync_error ?? ''}>!</span>}
              </a>
            ))}
          </div>
        ))}
        <h4>Account</h4>
        <Link className="nav" href="/settings">Settings</Link>
        <a className="nav" onClick={s.logout}>Sign out</a>
      </aside>

      <section className="list">
        <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <input placeholder="Search loaded threads…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {error && <div className="error" style={{ padding: 10 }}>{error}</div>}
        {!mailboxes.length && <div className="muted" style={{ padding: 14 }}>No mailboxes yet. <Link href="/settings?tab=mailboxes">Connect one</Link>.</div>}
        {visible.map((t) => (
          <div key={t.id} className={`item ${selected === t.id ? 'active' : ''} ${t.unread_count ? 'unread' : ''}`} onClick={() => { setSelected(t.id); setComposer(null); }}>
            <div className="row">
              <span className="grow subj">{t.summary.participants.slice(0, 3).join(', ') || '(no participants)'}</span>
              <span className="muted small">{timeAgo(t.last_message_at)}</span>
            </div>
            <div className="subj">{t.summary.subject || '(no subject)'} {t.message_count > 1 && <span className="muted small">({t.message_count})</span>}</div>
            <div className="snip">{t.summary.snippet}</div>
            <div className="row" style={{ marginTop: 2 }}>
              {t.has_pending && <span className="pill accent">awaiting approval</span>}
              {t.injection_flagged && <span className="pill warn">suspicious</span>}
            </div>
          </div>
        ))}
      </section>

      <main className="main">
        {composer && !selected && <Composer init={composer} mailboxes={mailboxes} onCancel={() => setComposer(null)} onDone={() => { setComposer(null); loadThreads(); }} />}
        {selected && <ThreadView key={selected} threadId={selected} mailboxes={mailboxes} onChanged={loadThreads} />}
        {!selected && !composer && <div className="muted" style={{ marginTop: '30vh', textAlign: 'center' }}>Select a thread</div>}
      </main>
    </div>
  );
}

function ThreadView({ threadId, mailboxes, onChanged }: { threadId: string; mailboxes: Mailbox[]; onChanged: () => void }) {
  const s = useSession();
  const [thread, setThread] = useState<ThreadRow | null>(null);
  const [messages, setMessages] = useState<(MessageRow & { m: SealedMessage })[]>([]);
  const [drafts, setDrafts] = useState<(DraftRow & { c: SealedDraft })[]>([]);
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  const [instruction, setInstruction] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ thread: ThreadRow; messages: MessageRow[]; drafts: DraftRow[] }>(`/inbox/threads/${threadId}`);
    setThread(r.thread);
    setMessages(await Promise.all(r.messages.map(async (x) => ({ ...x, m: await s.open<SealedMessage>(x.content_sealed) }))));
    setDrafts(await Promise.all(r.drafts.map(async (d) => ({ ...d, c: await s.open<SealedDraft>(d.content_sealed) }))));
    if (r.thread.unread_count > 0) { await api(`/inbox/threads/${threadId}/read`, { body: { read: true } }); onChanged(); }
  }, [threadId, s, onChanged]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!thread || !messages.length) return <div className="muted">Loading…</div>;
  const mailbox = mailboxes.find((m) => m.id === thread.mailbox_id);
  const self = mailbox?.email_address.toLowerCase() ?? '';
  const last = messages[messages.length - 1]!;
  const lastInbound = [...messages].reverse().find((x) => !x.is_outbound) ?? last;
  const subj = last.m.subject;
  const refs = [...lastInbound.m.references, ...(lastInbound.m.messageId ? [lastInbound.m.messageId] : [])];

  const reply = (all: boolean) => {
    const to = lastInbound.is_outbound ? lastInbound.m.to : [lastInbound.m.fromAddress];
    const cc = all ? [...lastInbound.m.to, ...lastInbound.m.cc].filter((a) => a !== self && !to.includes(a)) : [];
    setComposer({ mailboxId: thread.mailbox_id, threadId, inReplyToMessageId: lastInbound.id, to, cc, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
      text: `\n\nOn ${new Date(lastInbound.sent_at).toLocaleString()}, ${lastInbound.m.fromAddress} wrote:\n${lastInbound.m.text.split('\n').map((l) => `> ${l}`).join('\n')}`,
      inReplyTo: lastInbound.m.messageId, references: refs });
  };
  const forward = () => setComposer({ mailboxId: thread.mailbox_id, subject: /^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`,
    text: `\n\n---------- Forwarded message ----------\nFrom: ${last.m.fromAddress}\nDate: ${new Date(last.sent_at).toLocaleString()}\nSubject: ${subj}\nTo: ${last.m.to.join(', ')}\n\n${last.m.text}` });

  async function agentDraft() {
    setAgentBusy(true); setAgentError('');
    try {
      await api('/inbox/agent/draft', { body: { threadId, instruction: instruction || 'Draft an appropriate reply.' } });
      setInstruction('');
      await load(); onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 423 && s.privateKey && s.org) {
        // Unlock the server-side agent for 8 hours: the key is held in API memory only.
        if (confirm('The agent needs temporary access to decrypt this workspace on the server (held in memory only, 8 hours). Unlock now?')) {
          await api('/org/agent/unlock', { body: { organisationId: s.org.id, privateKey: await toB64(s.privateKey), ttlMinutes: 480 } });
          setAgentBusy(false); return agentDraft();
        }
      }
      setAgentError((e as Error).message);
    } finally { setAgentBusy(false); }
  }

  async function download(a: { id: string }) {
    const r = await api<{ meta_sealed: string; content_sealed: string }>(`/inbox/attachments/${a.id}`);
    const meta = await s.open<{ filename: string; contentType: string }>(r.meta_sealed);
    const bytes = await s.openBytes(r.content_sealed);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = meta.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function archive() {
    await api(`/inbox/threads/${threadId}/labels`, { body: thread!.labels.includes('archived') ? { remove: ['archived'] } : { add: ['archived'] } });
    onChanged(); await load();
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="grow" style={{ margin: 0, fontSize: 18 }}>{subj || '(no subject)'}</h2>
        <span className="muted small">{mailbox?.email_address}</span>
        <button className="btn" onClick={archive}>{thread.labels.includes('archived') ? 'Unarchive' : 'Archive'}</button>
      </div>
      {thread.injection_flagged && <div className="banner">This thread contains text that looks like instructions to an AI agent. Auto-send is disabled for it, and every agent reply needs your approval.</div>}
      {messages.map((x) => <MessageCard key={x.id} x={x} onDownload={download} />)}

      {drafts.map((d) => (
        <div key={d.id} className="card" style={{ marginBottom: 12, borderColor: d.status === 'pending_approval' ? 'var(--accent)' : undefined }}>
          <div className="row">
            <strong className="grow">{d.origin === 'user' ? 'Your draft' : 'Agent draft'} <span className="pill">{d.status.replace('_', ' ')}</span> {d.category && <span className="pill">{d.category}</span>}</strong>
            <button className="btn" onClick={() => setComposer({ mailboxId: thread.mailbox_id, threadId, to: d.c.to, cc: d.c.cc, bcc: d.c.bcc, subject: d.c.subject, text: d.c.text, inReplyTo: d.c.inReplyTo, references: d.c.references, draftId: d.id, draftStatus: d.status, note: d.c.note })}>
              {d.status === 'pending_approval' ? 'Review' : 'Edit'}</button>
          </div>
          {d.approval_reason && <div className="small muted">{d.approval_reason}</div>}
          {d.send_error && <div className="error">{d.send_error}</div>}
          <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>To: {d.c.to.join(', ')}{'\n'}{d.c.text.slice(0, 600)}</pre>
        </div>
      ))}

      {composer ? (
        <Composer init={composer} mailboxes={mailboxes} onCancel={() => setComposer(null)} onDone={() => { setComposer(null); load(); onChanged(); }} />
      ) : (
        <>
          <div className="row"><button className="btn primary" onClick={() => reply(false)}>Reply</button><button className="btn" onClick={() => reply(true)}>Reply all</button><button className="btn" onClick={forward}>Forward</button></div>
          <div className="card" style={{ marginTop: 12 }}>
            <strong>Ask the agent</strong>
            <p className="small muted" style={{ margin: '4px 0 8px' }}>Type or dictate an instruction, e.g. “reply to Liana, ask about the Blue Card, keep it polite”.</p>
            <textarea rows={2} style={{ minHeight: 60 }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Instruction for the agent…" />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={agentDraft} disabled={agentBusy}>{agentBusy ? 'Drafting…' : 'Draft with agent'}</button>
              <VoiceButton onText={(t) => setInstruction((p) => (p ? `${p} ${t}` : t))} />
              {agentError && <span className="error">{agentError}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MessageCard({ x, onDownload }: { x: MessageRow & { m: SealedMessage }; onDownload: (a: { id: string }) => void }) {
  const s = useSession();
  const [open, setOpen] = useState(true);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    Promise.all(x.attachments.map(async (a) => [a.id, (await s.open<{ filename: string }>(a.meta_sealed)).filename] as const))
      .then((pairs) => setNames(Object.fromEntries(pairs))).catch(() => undefined);
  }, [x.attachments, s]);
  return (
    <div className="msg">
      <header className="row" onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
        <div className="grow">
          <strong>{x.m.fromName || x.m.fromAddress}</strong> <span className="muted small">&lt;{x.m.fromAddress}&gt;</span>
          <div className="small muted">to {x.m.to.join(', ')}{x.m.cc.length ? `, cc ${x.m.cc.join(', ')}` : ''}</div>
        </div>
        <span className="muted small">{new Date(x.sent_at).toLocaleString()}</span>
      </header>
      {open && (
        <div className="body">
          <MailBody html={x.m.html} text={x.m.text} />
          {x.attachments.length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              {x.attachments.map((a) => <button key={a.id} className="btn small" onClick={() => onDownload(a)}>📎 {names[a.id] ?? 'attachment'} <span className="muted">({Math.ceil(a.size / 1024)} KB)</span></button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
