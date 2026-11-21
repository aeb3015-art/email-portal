'use client';
import { AuthShell } from '@/components/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const { login } = useSession();
  const router = useRouter();
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
      <form className="card" onSubmit={submit}>
        <label>Email</label>
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy}>{busy ? 'Deriving keys…' : 'Sign in'}</button>
          <span className="grow" />
          <Link className="small" href="/register">Create account</Link>
          <Link className="small" href="/recover">Forgot password</Link>
        </div>
      </form>
    </AuthShell>
  );
}
