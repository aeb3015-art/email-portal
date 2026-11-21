'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  deriveKeyFromSecret, deriveKeys, getSodium, newKdfParams, PERMISSION_LEVELS, toB64, wrapSecret,
  type SealedAgentInstructions, type SealedKnowledgeItem, type SealedVoiceProfile,
} from '@inbox-os/shared';
import { Gate } from '@/components/Gate';
import type { Mailbox } from '@/components/Composer';
import { api, API_URL, type ApiError } from '@/lib/api';
import { BRANDS, BrandLogo, brandFor, type MailBrand } from '@/components/Brand';
import { useSession } from '@/lib/session';
import { usePasskeys } from '@/lib/passkey';
import { Brand, Icon, ThemeToggle } from '@/components/ui';

const TABS = ['mailboxes', 'workspaces', 'agent', 'mcp', 'members', 'security', 'audit'] as const;
type Tab = (typeof TABS)[number];
interface Workspace { id: string; name: string; description: string | null; permission_level: string; mailbox_count: number }

export default function SettingsPage() { return <Gate><Settings /></Gate>; }

function Settings() {
  const [tab, setTab] = useState<Tab>('mailboxes');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const loadWs = useCallback(() => api<{ workspaces: Workspace[] }>('/workspaces').then((r) => setWorkspaces(r.workspaces)), []);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
    if (new URLSearchParams(window.location.search).get('oauth')) setTab('mailboxes');
    loadWs();
  }, [loadWs]);

  return (
    <div className="page">
      <div className="row topbar"><Link className="btn" href="/"><Icon name="back" size={16} /> Inbox</Link><span className="grow" /><ThemeToggle /><Brand size={24} /></div>
      <h1>Settings</h1>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'mcp' ? 'MCP' : t[0]!.toUpperCase() + t.slice(1)}</button>)}</div>
      {tab === 'mailboxes' && <Mailboxes workspaces={workspaces} />}
      {tab === 'workspaces' && <Workspaces workspaces={workspaces} reload={loadWs} />}
      {tab === 'agent' && <Agent />}
      {tab === 'mcp' && <McpTokens workspaces={workspaces} />}
      {tab === 'members' && <Members />}
      {tab === 'security' && <><Passkeys /><Security /></>}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

// ---------------- Mailboxes ----------------
interface MailboxRow extends Mailbox { config_public?: { brand?: string; imapHost?: string } | null; last_synced_at?: string | null }
const STATUS: Record<string, { label: string; tone: string }> = {
  idle: { label: 'Up to date', tone: 'ok' }, syncing: { label: 'Syncing…', tone: 'muted' }, pending: { label: 'Waiting for first sync', tone: 'muted' },
  error: { label: 'Needs attention', tone: 'warn' }, disabled: { label: 'Paused', tone: 'muted' },
};

function Mailboxes({ workspaces }: { workspaces: Workspace[] }) {
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const oauth = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('oauth') : null;

  const load = useCallback(async () => { setMailboxes((await api<{ mailboxes: MailboxRow[] }>('/mailboxes')).mailboxes); setLoaded(true); }, []);
  useEffect(() => { load(); }, [load]);
  // Start with the account picker when nothing is connected yet.
  useEffect(() => { if (loaded && !mailboxes.length) setAdding(true); }, [loaded, mailboxes.length]);

  if (adding) return <AddAccount workspaces={workspaces} canCancel={mailboxes.length > 0} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); api('/mailboxes/sync', { method: 'POST' }).then(load).catch(() => undefined); }} />;

  return (
    <div>
      {oauth && <div className="banner">{oauth === 'connected' ? 'Account connected.' : 'The provider sign-in did not complete. Please try again.'}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 className="grow" style={{ margin: 0 }}>Accounts</h3>
        <button className="btn primary" onClick={() => setAdding(true)}>Add account</button>
      </div>
      <div className="acctlist">
        {mailboxes.map((m) => {
          const st = STATUS[m.enabled ? m.sync_state : 'disabled'] ?? STATUS.pending!;
          return (
            <div key={m.id} className="acct">
              <BrandLogo brand={brandFor(m)} />
              <div className="grow">
                <div className="subj"><strong>{m.display_name || m.email_address}</strong></div>
                <div className="small muted subj">{m.display_name ? `${m.email_address} · ` : ''}<span className={st.tone}>{st.label}</span></div>
                {m.sync_error && m.enabled && <div className="small warn">{m.sync_error}</div>}
              </div>
              {workspaces.length > 1 && (
                <select style={{ width: 150 }} value={m.workspace_id} onChange={async (e) => { await api(`/mailboxes/${m.id}`, { method: 'PATCH', body: { workspaceId: e.target.value } }); load(); }}>
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              )}
              <button className="btn small" onClick={async () => { await api(`/mailboxes/${m.id}`, { method: 'PATCH', body: { enabled: !m.enabled } }); load(); }}>{m.enabled ? 'Pause' : 'Resume'}</button>
              <button className="btn small danger" onClick={async () => { if (confirm(`Remove ${m.email_address} and its synced mail from Inbox OS? Mail stays on the mail server.`)) { await api(`/mailboxes/${m.id}`, { method: 'DELETE' }); load(); } }}>Remove</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddAccount({ workspaces, canCancel, onCancel, onDone }: { workspaces: Workspace[]; canCancel: boolean; onCancel: () => void; onDone: () => void }) {
  const [brand, setBrand] = useState<MailBrand | null>(null);
  const [providers, setProviders] = useState({ outlook: false, gmail: false });
  const [f, setF] = useState({ email: '', password: '', name: '', workspaceId: '' });
  const [manual, setManual] = useState(false);
  const [hosts, setHosts] = useState({ imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true, username: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api('/oauth/providers').then(setProviders).catch(() => undefined); }, []);
  useEffect(() => { if (!f.workspaceId && workspaces[0]) setF((x) => ({ ...x, workspaceId: workspaces[0]!.id })); }, [workspaces, f.workspaceId]);

  const info = BRANDS.find((b) => b.id === brand);
  const oauthKind = brand === 'microsoft' ? 'outlook' : brand === 'google' ? 'gmail' : null;
  const oauthReady = oauthKind ? providers[oauthKind] : false;

  async function startOAuth() {
    setBusy(true); setError('');
    try { window.location.href = (await api<{ url: string }>(`/oauth/${oauthKind}/start`, { body: { workspaceId: f.workspaceId } })).url; }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const emailAddress = f.email.trim().toLowerCase();
    try {
      if (manual) {
        await api('/mailboxes', { body: { workspaceId: f.workspaceId, emailAddress, displayName: f.name || undefined, provider: 'imap',
          config: { imapHost: hosts.imapHost, imapPort: Number(hosts.imapPort), imapSecure: hosts.imapSecure, smtpHost: hosts.smtpHost, smtpPort: Number(hosts.smtpPort), smtpSecure: hosts.smtpSecure, username: hosts.username || emailAddress, password: f.password } } });
      } else {
        await api('/mailboxes/quick', { body: { workspaceId: f.workspaceId, emailAddress, password: f.password, provider: brand, displayName: f.name || undefined } });
      }
      onDone();
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.message);
      // Could not find the server on our own: offer the manual fields, pre-filled with the usual guess.
      if (e2.code === 'not_found' && brand === 'other' && !manual) {
        const domain = emailAddress.split('@')[1] ?? '';
        setHosts((x) => ({ ...x, imapHost: `mail.${domain}`, smtpHost: `mail.${domain}`, username: emailAddress }));
        setManual(true);
      }
    } finally { setBusy(false); }
  }

  if (!brand) {
    return (
      <div className="addacct">
        <h3 style={{ marginTop: 0 }}>Add account</h3>
        <p className="muted" style={{ marginTop: -6 }}>Choose your mail provider.</p>
        <div className="brandlist">
          {BRANDS.map((b) => (
            <button key={b.id} className="brandrow" onClick={() => { setBrand(b.id); setError(''); setManual(false); }}>
              <BrandLogo brand={b.id} /><span className="grow">{b.name}</span><Icon name="chevron" size={16} />
            </button>
          ))}
        </div>
        {canCancel && <button className="btn" style={{ marginTop: 16 }} onClick={onCancel}>Cancel</button>}
      </div>
    );
  }

  return (
    <div className="addacct">
      <button className="btn small" onClick={() => setBrand(null)}><Icon name="back" size={14} /> Providers</button>
      <div className="row" style={{ margin: '18px 0 6px' }}><BrandLogo brand={brand} size={44} /><h3 style={{ margin: 0 }}>{info!.name}</h3></div>

      {oauthReady && (
        <>
          <button className="btn primary wide" disabled={busy} onClick={startOAuth}>Sign in with {brand === 'google' ? 'Google' : 'Microsoft'}</button>
          <div className="or"><span>or use an app password</span></div>
        </>
      )}
      {brand === 'microsoft' && !oauthReady && (
        <div className="banner">Most Microsoft accounts (Outlook.com, Hotmail, Microsoft 365) only allow Microsoft's own sign-in, which isn't switched on for this server yet. An app password works only if your organisation still allows it.</div>
      )}

      <form onSubmit={connect}>
        <label>Email</label>
        <input type="email" autoComplete="email" autoFocus required placeholder={brand === 'other' ? 'you@yourdomain.com' : 'name@example.com'} value={f.email} onChange={(e) => { setError(''); setF({ ...f, email: e.target.value }); }} />
        <label>{info!.passwordLabel}</label>
        <input type="password" autoComplete="off" required value={f.password} onChange={(e) => { setError(''); setF({ ...f, password: e.target.value }); }} />
        {info!.hint && <p className="small muted" style={{ margin: '6px 0 0' }}>{info!.hint} {info!.help && <a href={info!.help.url} target="_blank" rel="noopener noreferrer">{info!.help.label}</a>}</p>}
        <label>Description (optional)</label>
        <input placeholder="e.g. Brokerage sales" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {workspaces.length > 1 && (<>
          <label>Workspace</label>
          <select value={f.workspaceId} onChange={(e) => setF({ ...f, workspaceId: e.target.value })}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </>)}

        {manual && (
          <div className="manual">
            <strong>Server settings</strong>
            <p className="small muted" style={{ margin: '2px 0 0' }}>You can find these in your hosting control panel under "Email accounts" or "Connect devices".</p>
            <div className="grid2">
              <div><label>Incoming server (IMAP)</label><input value={hosts.imapHost} onChange={(e) => setHosts({ ...hosts, imapHost: e.target.value })} required /></div>
              <div><label>Port</label><input type="number" value={hosts.imapPort} onChange={(e) => setHosts({ ...hosts, imapPort: Number(e.target.value), imapSecure: Number(e.target.value) === 993 })} /></div>
              <div><label>Outgoing server (SMTP)</label><input value={hosts.smtpHost} onChange={(e) => setHosts({ ...hosts, smtpHost: e.target.value })} required /></div>
              <div><label>Port</label><input type="number" value={hosts.smtpPort} onChange={(e) => setHosts({ ...hosts, smtpPort: Number(e.target.value), smtpSecure: Number(e.target.value) === 465 })} /></div>
            </div>
            <label>Username</label><input value={hosts.username} onChange={(e) => setHosts({ ...hosts, username: e.target.value })} placeholder={f.email} />
          </div>
        )}

        {error && <div className="error">{error}</div>}
        <button className="btn primary wide" style={{ marginTop: 16 }} disabled={busy}>{busy ? (manual ? 'Checking settings…' : 'Finding your mail server…') : 'Sign in'}</button>
        {brand === 'other' && !manual && <a className="small" style={{ display: 'inline-block', marginTop: 12 }} onClick={() => { setManual(true); const d = f.email.split('@')[1] ?? ''; setHosts((x) => ({ ...x, imapHost: x.imapHost || (d ? `mail.${d}` : ''), smtpHost: x.smtpHost || (d ? `mail.${d}` : '') })); }}>Enter server settings manually</a>}
        <p className="small muted" style={{ marginTop: 14 }}>Your password is stored encrypted and used only to fetch and send your mail.</p>
      </form>
    </div>
  );
}

// ---------------- Workspaces ----------------
function Workspaces({ workspaces, reload }: { workspaces: Workspace[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (!sel && workspaces[0]) setSel(workspaces[0].id); }, [workspaces, sel]);
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          {workspaces.map((w) => <button key={w.id} className={`btn ${sel === w.id ? 'primary' : ''}`} onClick={() => setSel(w.id)}>{w.name}</button>)}
          <span className="grow" />
          <input style={{ width: 200 }} placeholder="New workspace" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={!name.trim()} onClick={async () => { await api('/workspaces', { body: { name } }); setName(''); reload(); }}>Add</button>
        </div>
      </div>
      {sel && <WorkspaceDetail key={sel} id={sel} ws={workspaces.find((w) => w.id === sel)!} reload={reload} />}
    </div>
  );
}

function WorkspaceDetail({ id, ws, reload }: { id: string; ws: Workspace; reload: () => void }) {
  const s = useSession();
  const [level, setLevel] = useState('draft');
  const [cats, setCats] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [voice, setVoice] = useState<SealedVoiceProfile>({ tone: '', signature: '', sampleText: '', language: 'en' });
  const [items, setItems] = useState<{ id: string; v: SealedKnowledgeItem }[]>([]);
  const [newItem, setNewItem] = useState<SealedKnowledgeItem>({ title: '', content: '' });
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const a = await api(`/workspaces/${id}/agent`);
    setLevel(a.permission_level); setCats((a.auto_send_categories ?? []).join(', ')); setModel(a.model ?? '');
    setInstructions(a.instructions_sealed ? (await s.open<SealedAgentInstructions>(a.instructions_sealed)).instructions : '');
    const v = await api(`/workspaces/${id}/voice`);
    if (v.profile_sealed) setVoice(await s.open<SealedVoiceProfile>(v.profile_sealed));
    const k = await api<{ items: { id: string; item_sealed: string }[] }>(`/workspaces/${id}/knowledge`);
    setItems(await Promise.all(k.items.map(async (i) => ({ id: i.id, v: await s.open<SealedKnowledgeItem>(i.item_sealed) }))));
  }, [id, s]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{ws.name}: agent permissions</h3>
        <label>Permission level</label>
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {PERMISSION_LEVELS.map((p) => <option key={p} value={p}>{{ read_only: 'Read only: agent can read, never drafts', draft: 'Draft: agent drafts, a person sends', send_with_approval: 'Send with approval: agent queues sends for approval', auto_send: 'Auto-send: only for the categories below' }[p]}</option>)}
        </select>
        {level === 'auto_send' && (<>
          <label>Auto-send categories (comma separated, e.g. scheduling, acknowledgement)</label>
          <input value={cats} onChange={(e) => setCats(e.target.value)} />
          <p className="small muted">Even in these categories, auto-send only fires for replies to people already in the thread, never on threads that try to instruct the agent, and only while the agent is unlocked. Everything else goes to the approval queue.</p>
        </>)}
        <label>Standing instructions for the agent (encrypted)</label>
        <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Never commit to prices. Always offer a call." />
        <label>Model (optional)</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={async () => {
            await api(`/workspaces/${id}/agent`, { method: 'PUT', body: { permissionLevel: level, autoSendCategories: cats.split(',').map((c) => c.trim()).filter(Boolean), instructionsSealed: await s.seal({ instructions }), model: model || undefined } });
            reload(); flash('Saved');
          }}>Save</button>{msg && <span className="ok">{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Writing voice</h3>
        <div className="grid2">
          <div><label>Tone</label><input value={voice.tone} onChange={(e) => setVoice({ ...voice, tone: e.target.value })} placeholder="Warm, concise, direct" /></div>
          <div><label>Language</label><input value={voice.language} onChange={(e) => setVoice({ ...voice, language: e.target.value })} /></div>
        </div>
        <label>Signature</label><textarea rows={3} style={{ minHeight: 70 }} value={voice.signature} onChange={(e) => setVoice({ ...voice, signature: e.target.value })} />
        <label>Sample of your writing</label><textarea rows={4} value={voice.sampleText} onChange={(e) => setVoice({ ...voice, sampleText: e.target.value })} />
        <button className="btn primary" style={{ marginTop: 12 }} onClick={async () => { await api(`/workspaces/${id}/voice`, { method: 'PUT', body: { sealed: await s.seal(voice) } }); flash('Saved'); }}>Save voice</button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Knowledge base</h3>
        {items.map((i) => (
          <div key={i.id} className="row" style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
            <div className="grow"><strong>{i.v.title}</strong><div className="small muted">{i.v.content.slice(0, 160)}</div></div>
            <button className="btn small danger" onClick={async () => { await api(`/workspaces/${id}/knowledge/${i.id}`, { method: 'DELETE' }); load(); }}>Delete</button>
          </div>
        ))}
        <label>Title</label><input value={newItem.title} onChange={(e) => setNewItem({ ...newItem, title: e.target.value })} />
        <label>Content</label><textarea rows={4} value={newItem.content} onChange={(e) => setNewItem({ ...newItem, content: e.target.value })} />
        <button className="btn" style={{ marginTop: 12 }} disabled={!newItem.title} onClick={async () => { await api(`/workspaces/${id}/knowledge`, { body: { sealed: await s.seal(newItem) } }); setNewItem({ title: '', content: '' }); load(); }}>Add note</button>
      </div>
    </div>
  );
}

// ---------------- Agent (unlock + AI key) ----------------
function Agent() {
  const s = useSession();
  const [status, setStatus] = useState<{ unlocked: boolean; expiresAt: string | null }>({ unlocked: false, expiresAt: null });
  const [keys, setKeys] = useState<{ provider: string; key_hint: string }[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [hours, setHours] = useState(8);
  const [error, setError] = useState('');
  const load = useCallback(async () => { setStatus(await api('/org/agent')); setKeys((await api('/org/ai-key')).keys); }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Server-side agent access</h3>
        <p className="small muted">Your data is encrypted with a key only your browser holds. For the agent to draft (and auto-send) on new mail while you're away, a member must lend the key to the API for a limited time. It is held only in server memory, never written to disk, and is wiped on lock, expiry or restart. MCP tokens carry their own key and don't need this.</p>
        <div className="row">
          <strong className={status.unlocked ? 'ok' : 'muted'}>{status.unlocked ? `Unlocked until ${new Date(status.expiresAt!).toLocaleString()}` : 'Locked'}</strong>
          <span className="grow" />
          {status.unlocked ? <button className="btn" onClick={async () => { await api('/org/agent/lock', { method: 'POST' }); load(); }}>Lock now</button> : (<>
            <select style={{ width: 120 }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hours</option>)}</select>
            <button className="btn primary" onClick={async () => { await api('/org/agent/unlock', { body: { organisationId: s.org!.id, privateKey: await toB64(s.privateKey!), ttlMinutes: hours * 60 } }); load(); }}>Unlock agent</button>
          </>)}
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>AI provider key (bring your own)</h3>
        <p className="small muted">The key is encrypted in your browser with the organisation key. The server can only use it while the agent is unlocked or through an MCP token.</p>
        {keys.map((k) => <div key={k.provider} className="row"><span className="grow">{k.provider}: …{k.key_hint}</span><button className="btn small danger" onClick={async () => { await api(`/org/ai-key/${k.provider}`, { method: 'DELETE' }); load(); }}>Remove</button></div>)}
        <label>Anthropic API key</label>
        <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
        {error && <div className="error">{error}</div>}
        <button className="btn primary" style={{ marginTop: 12 }} disabled={apiKey.length < 10} onClick={async () => {
          try { await api('/org/ai-key', { method: 'PUT', body: { provider: 'anthropic', sealed: await s.seal(apiKey.trim()), hint: apiKey.trim().slice(-4) } }); setApiKey(''); load(); }
          catch (e) { setError((e as Error).message); }
        }}>Save key</button>
      </div>
    </div>
  );
}

// ---------------- MCP tokens ----------------
function McpTokens({ workspaces }: { workspaces: Workspace[] }) {
  const s = useSession();
  const [tokens, setTokens] = useState<{ id: string; name: string; token_prefix: string; workspace_ids: string[]; last_used_at: string | null; revoked_at: string | null }[]>([]);
  const [name, setName] = useState('Claude');
  const [selected, setSelected] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const load = useCallback(async () => setTokens((await api('/org/tokens')).tokens), []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    const sodium = await getSodium();
    const token = `iox_${await toB64(sodium.randombytes_buf(32))}`;
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const wrappedOrgKey = await wrapSecret(s.privateKey!, await deriveKeyFromSecret(token, 'mcp-token'));
    await api('/org/tokens', { body: { name, workspaceIds: selected, tokenHash, tokenPrefix: token.slice(0, 10), wrappedOrgKey } });
    setCreated(token); load();
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>MCP endpoint</h3>
        <div className="code">{API_URL}/mcp</div>
        <p className="small muted">Add this URL as a custom connector in Claude with a token below as the bearer token. A token can only reach the workspaces you pick, follows each workspace's permission level, and holds its own copy of the decryption key that only the token itself can open.</p>
      </div>
      {created && <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent)' }}>
        <strong>New token (shown once)</strong><div className="code" style={{ marginTop: 8 }}>{created}</div>
        <div className="row" style={{ marginTop: 8 }}><button className="btn" onClick={() => navigator.clipboard.writeText(created)}>Copy</button><button className="btn" onClick={() => setCreated(null)}>Done</button></div>
      </div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Workspaces</label>
        <div className="row">{workspaces.map((w) => (
          <label key={w.id} className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={selected.includes(w.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, w.id] : selected.filter((x) => x !== w.id))} />{w.name} <span className="pill">{w.permission_level}</span></label>
        ))}</div>
        <button className="btn primary" style={{ marginTop: 12 }} disabled={!selected.length || !name} onClick={create}>Create token</button>
      </div>
      <div className="card">
        <table><thead><tr><th>Name</th><th>Prefix</th><th>Workspaces</th><th>Last used</th><th /></tr></thead><tbody>
          {tokens.map((t) => <tr key={t.id}><td>{t.name}</td><td className="small">{t.token_prefix}…</td><td className="small">{t.workspace_ids.map((id) => workspaces.find((w) => w.id === id)?.name ?? '?').join(', ')}</td>
            <td className="small">{t.revoked_at ? <span className="warn">revoked</span> : t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'never'}</td>
            <td>{!t.revoked_at && <button className="btn small danger" onClick={async () => { await api(`/org/tokens/${t.id}`, { method: 'DELETE' }); load(); }}>Revoke</button>}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------------- Members ----------------
function Members() {
  const s = useSession();
  const [members, setMembers] = useState<{ id: string; email: string; name: string; role: string }[]>([]);
  const [f, setF] = useState({ email: '', name: '', role: 'member', password: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const load = useCallback(async () => setMembers((await api('/org/members')).members), []);
  useEffect(() => { load(); }, [load]);

  async function invite() {
    setError(''); setDone('');
    try {
      if (f.password.length < 10) throw new Error('Temporary password must be at least 10 characters');
      const kdf = await newKdfParams();
      const { authKey, wrapKey } = await deriveKeys(f.password, kdf);
      await api('/org/members', { body: { email: f.email, name: f.name, role: f.role, authKey, kdf, wrappedOrgKey: await wrapSecret(s.privateKey!, wrapKey) } });
      setDone(`Invited ${f.email}. Share the temporary password with them privately; they should change it under Security.`);
      setF({ email: '', name: '', role: 'member', password: '' }); load();
    } catch (e) { setError((e as Error).message); }
  }

  const canManage = s.org?.role !== 'member';
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead><tbody>
          {members.map((m) => <tr key={m.id}><td>{m.name}</td><td>{m.email}</td>
            <td>{canManage && m.id !== s.me!.user.id ? <select value={m.role} onChange={async (e) => { try { await api(`/org/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }); } catch (err) { alert((err as Error).message); } load(); }}>
              {['owner', 'admin', 'member'].map((r) => <option key={r}>{r}</option>)}</select> : m.role}</td>
            <td>{canManage && m.role !== 'owner' && <button className="btn small danger" onClick={async () => { await api(`/org/members/${m.id}`, { method: 'DELETE' }); load(); }}>Remove</button>}</td></tr>)}
        </tbody></table>
      </div>
      {canManage && <div className="card">
        <h3 style={{ marginTop: 0 }}>Invite a member</h3>
        <p className="small muted">Your browser wraps the organisation key with a key derived from a temporary password. The server never sees either.</p>
        <div className="grid2">
          <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label>Email</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option>member</option><option>admin</option></select></div>
          <div><label>Temporary password</label><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        </div>
        {error && <div className="error">{error}</div>}{done && <div className="ok small" style={{ marginTop: 8 }}>{done}</div>}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={invite}>Invite</button>
      </div>}
    </div>
  );
}

// ---------------- Security ----------------
function Passkeys() {
  const s = useSession();
  const hasPasskeys = usePasskeys();
  const [rows, setRows] = useState<{ id: string; name: string; created_at: string; last_used_at: string | null; can_unlock: boolean }[]>([]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setRows((await api('/auth/passkeys', { noOrg: true })).passkeys), []);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!hasPasskeys) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Passkeys</h3>
      <p className="small muted">Sign in and unlock your mail with Face ID, Touch ID or your device PIN. Each passkey holds its own protected copy of your encryption key; the server never sees it.</p>
      {rows.map((r) => (
        <div key={r.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line-2)' }}>
          <Icon name="key" size={16} />
          <div className="grow"><strong>{r.name}</strong> {!r.can_unlock && <span className="pill warn">sign-in only</span>}
            <div className="small muted">Added {new Date(r.created_at).toLocaleDateString()}{r.last_used_at ? ` · last used ${new Date(r.last_used_at).toLocaleDateString()}` : ''}</div></div>
          <button className="btn small danger" onClick={async () => { try { await api(`/auth/passkeys/${r.id}`, { method: 'DELETE', noOrg: true }); load(); } catch (e) { setMsg((e as Error).message); } }}>Remove</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <input style={{ maxWidth: 240 }} placeholder="Name, e.g. MacBook" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg('');
          try {
            const ok = await s.addPasskey(name || 'Passkey');
            setMsg(ok ? 'Passkey added.' : 'Passkey added for sign-in, but this device cannot use it to unlock encrypted mail. You will still need your password.');
            setName(''); load();
          } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
        }}><Icon name="key" size={16} /> Add a passkey</button>
      </div>
      {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

function Security() {
  const s = useSession();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState('');
  async function change() {
    setMsg('');
    try {
      if (next.length < 10) throw new Error('Use at least 10 characters');
      const current = await deriveKeys(cur, s.me!.user.kdf_params);
      const kdf = await newKdfParams();
      const derived = await deriveKeys(next, kdf);
      const { unwrapSecret } = await import('@inbox-os/shared');
      const wrappedOrgKeys = await Promise.all(s.me!.organisations.map(async (o) => ({ organisationId: o.id, wrappedOrgKey: await wrapSecret(await unwrapSecret(o.wrapped_org_key, current.wrapKey), derived.wrapKey) })));
      await api('/auth/change-password', { noOrg: true, body: { currentAuthKey: current.authKey, authKey: derived.authKey, kdf, wrappedOrgKeys } });
      setMsg('Password changed. Other sessions were signed out.'); setCur(''); setNext('');
      await s.refresh();
    } catch (e) { setMsg((e as Error).message); }
  }
  if (!s.me!.user.has_password) return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Password</h3>
      <p className="small muted" style={{ marginBottom: 0 }}>This account signs in with a passkey and has no password. Keep your recovery key safe, and add a second passkey on another device as a backup.</p>
    </div>
  );
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{s.me!.user.has_password ? 'Change password' : 'Password'}</h3>
      {!s.me!.user.has_password && <p className="small muted">This account signs in with a passkey and has no password. Keep your recovery key safe, and add a second passkey on another device as a backup.</p>}
      <p className="small muted">Your organisation key is re-encrypted with the new password in this browser.</p>
      <label>Current password</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
      <label>New password</label><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
      <button className="btn primary" style={{ marginTop: 12 }} onClick={change}>Change password</button>
    </div>
  );
}

// ---------------- Audit ----------------
function Audit() {
  const [rows, setRows] = useState<{ id: number; actor_type: string; actor_email: string | null; action: string; target_type: string | null; metadata: Record<string, unknown>; created_at: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api('/org/audit').then((r) => setRows(r.entries)).catch((e) => setError(e.message)); }, []);
  return (
    <div className="card">
      {error && <div className="error">{error}</div>}
      <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.id}><td className="small">{new Date(r.created_at).toLocaleString()}</td><td className="small">{r.actor_type}{r.actor_email ? ` · ${r.actor_email}` : ''}</td>
          <td>{r.action}</td><td className="small muted">{Object.entries(r.metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(' · ')}</td></tr>)}
      </tbody></table>
    </div>
  );
}
