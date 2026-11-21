'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { SealedDraft } from '@inbox-os/shared';
import { Gate } from '@/components/Gate';
import { Composer, type Mailbox } from '@/components/Composer';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Brand, Icon } from '@/components/ui';

interface Draft { id: string; workspace_id: string; mailbox_id: string; thread_id: string | null; origin: string; category: string | null; content_sealed: string; approval_reason: string | null; updated_at: string; status: string }

export default function ApprovalsPage() { return <Gate><Approvals /></Gate>; }

function Approvals() {
  const s = useSession();
  const [drafts, setDrafts] = useState<(Draft & { c: SealedDraft })[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [d, m] = await Promise.all([api<{ drafts: Draft[] }>('/inbox/approvals'), api<{ mailboxes: Mailbox[] }>('/mailboxes')]);
    setMailboxes(m.mailboxes);
    setDrafts(await Promise.all(d.drafts.map(async (x) => ({ ...x, c: await s.open<SealedDraft>(x.content_sealed) }))));
  }, [s]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  return (
    <div className="page">
      <div className="row topbar"><Link className="btn" href="/"><Icon name="back" size={16} /> Inbox</Link><span className="grow" /><Brand size={24} /></div>
      <h1>Approval queue</h1>
      <p className="muted">Drafts the agent (or an MCP client) wants to send. Nothing here leaves until a person approves it.</p>
      {error && <div className="error">{error}</div>}
      {!drafts.length && <div className="card muted">Nothing waiting for approval.</div>}
      {drafts.map((d) => {
        const mb = mailboxes.find((m) => m.id === d.mailbox_id);
        return (
          <div key={d.id} className="card" style={{ marginBottom: 12 }}>
            <div className="row">
              <strong className="grow">{d.c.subject || '(no subject)'}</strong>
              <span className="pill">{d.origin}</span>{d.category && <span className="pill">{d.category}</span>}
              <span className="muted small">{timeAgo(d.updated_at)}</span>
            </div>
            <div className="small muted">From {mb?.email_address} to {d.c.to.join(', ')}</div>
            {d.approval_reason && <div className="small warn">{d.approval_reason}</div>}
            {open === d.id ? (
              <Composer
                init={{ mailboxId: d.mailbox_id, threadId: d.thread_id ?? undefined, to: d.c.to, cc: d.c.cc, bcc: d.c.bcc, subject: d.c.subject, text: d.c.text, inReplyTo: d.c.inReplyTo, references: d.c.references, draftId: d.id, draftStatus: d.status, note: d.c.note }}
                mailboxes={mailboxes} onCancel={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />
            ) : (
              <>
                <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.c.text.slice(0, 800)}</pre>
                <div className="row">
                  <button className="btn primary" onClick={() => setOpen(d.id)}>Review & send</button>
                  <button className="btn danger" onClick={async () => { await api(`/inbox/approvals/${d.id}/reject`, { method: 'POST' }); load(); }}>Reject</button>
                  {d.thread_id && <span className="muted small">Thread {d.thread_id.slice(0, 8)}</span>}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
