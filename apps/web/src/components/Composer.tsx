'use client';
import { useState } from 'react';
import type { SealedDraft } from '@inbox-os/shared';
import { api } from '@/lib/api';
import { fileToBase64, splitAddresses } from '@/lib/format';
import { useSession } from '@/lib/session';

export interface Mailbox { id: string; email_address: string; display_name: string | null; workspace_id: string; provider: string; sync_state: string; sync_error: string | null; enabled: boolean }

export interface ComposerInit {
  mailboxId: string;
  threadId?: string;
  inReplyToMessageId?: string;
  to?: string[]; cc?: string[]; bcc?: string[];
  subject?: string; text?: string;
  inReplyTo?: string | null; references?: string[];
  /** Existing draft (user-saved or agent-generated). */
  draftId?: string;
  draftStatus?: string;
  note?: string;
}

export function Composer({ init, mailboxes, onDone, onCancel }: { init: ComposerInit; mailboxes: Mailbox[]; onDone: () => void; onCancel: () => void }) {
  const { seal } = useSession();
  const [mailboxId, setMailboxId] = useState(init.mailboxId);
  const [to, setTo] = useState((init.to ?? []).join(', '));
  const [cc, setCc] = useState((init.cc ?? []).join(', '));
  const [bcc, setBcc] = useState((init.bcc ?? []).join(', '));
  const [subject, setSubject] = useState(init.subject ?? '');
  const [text, setText] = useState(init.text ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [draftId, setDraftId] = useState(init.draftId);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const isApproval = init.draftStatus === 'pending_approval';

  const content = (): SealedDraft => ({ to: splitAddresses(to), cc: splitAddresses(cc), bcc: splitAddresses(bcc), subject, text, html: null, inReplyTo: init.inReplyTo ?? null, references: init.references ?? [] });

  async function save() {
    setBusy('save'); setError('');
    try {
      const sealed = await seal(content());
      if (draftId) await api(`/inbox/drafts/${draftId}`, { method: 'PUT', body: { sealed } });
      else setDraftId((await api<{ id: string }>('/inbox/drafts', { body: { mailboxId, threadId: init.threadId, inReplyToMessageId: init.inReplyToMessageId, sealed } })).id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  async function send() {
    setBusy('send'); setError('');
    try {
      const c = content();
      if (!c.to.length) throw new Error('Add at least one recipient');
      const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type || 'application/octet-stream', contentBase64: await fileToBase64(f) })));
      const message = { to: c.to, cc: c.cc, bcc: c.bcc, subject, text, html: null, attachments, inReplyTo: c.inReplyTo, references: c.references };
      if (isApproval && draftId) await api(`/inbox/approvals/${draftId}/approve`, { body: { message } });
      else await api('/inbox/send', { body: { mailboxId, threadId: init.threadId, inReplyToMessageId: init.inReplyToMessageId, draftId, message } });
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  async function reject() {
    if (!draftId) return;
    setBusy('reject');
    try { await api(`/inbox/approvals/${draftId}/reject`, { method: 'POST' }); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      {init.note && <div className="banner">Agent note: {init.note}</div>}
      <div className="grid2">
        <div><label>From</label>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} disabled={!!init.threadId}>
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.display_name ? `${m.display_name} <${m.email_address}>` : m.email_address}</option>)}
          </select></div>
        <div><label>To</label><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, …" /></div>
        <div><label>Cc</label><input value={cc} onChange={(e) => setCc(e.target.value)} /></div>
        <div><label>Bcc</label><input value={bcc} onChange={(e) => setBcc(e.target.value)} /></div>
      </div>
      <label>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} />
      <label>Message</label><textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} />
      <label>Attachments</label>
      <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={send} disabled={!!busy}>{busy === 'send' ? 'Sending…' : isApproval ? 'Approve & send' : 'Send'}</button>
        <button className="btn" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
        {isApproval && <button className="btn danger" onClick={reject} disabled={!!busy}>Reject</button>}
        <span className="grow" />
        <button className="btn" onClick={onCancel}>Close</button>
      </div>
    </div>
  );
}
