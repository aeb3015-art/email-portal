'use client';
import { AuthShell, Icon } from '@/components/ui';
import { usePasskeys } from '@/lib/passkey';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const { login, loginWithPasskey } = useSession();
  const router = useRouter();
  const hasPasskeys = usePasskeys();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await login(email.trim().toLowerCase(), password);
      router.push('/');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <AuthShell title="Sign in to Inbox OS" subtitle={<>Your password never leaves this device. It unlocks your organisation's encryption key locally.</>}>
      {hasPasskeys && (
        <>
          <button type="button" className="btn primary wide" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { await loginWithPasskey(); router.push('/'); } catch (err) { setError((err as Error).message); if (/Signed in/.test((err as Error).message)) router.push('/'); } finally { setBusy(false); }
          }}><Icon name="key" size={16} /> Sign in with a passkey</button>
          <div className="or"><span>or use your password</span></div>
        </>
      )}
      <form className="card" onSubmit={submit}>
        <label>Email</label>
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <span className="grow" />
          <Link className="small" href="/register">Create account</Link>
          <Link className="small" href="/recover">Forgot password</Link>
        </div>
      </form>
    </AuthShell>
  );
}
