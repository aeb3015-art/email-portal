'use client';
import { AuthShell } from '@/components/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

/** Requires a session AND the org key unlocked in this tab (memory only). */
export function Gate({ children }: { children: ReactNode }) {
  const { ready, me, privateKey, unlock, logout } = useSession();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (ready && !me) router.replace('/login'); }, [ready, me, router]);
  if (!ready || !me) return <div className="auth muted">Loading…</div>;
  if (!me.organisations.length) return <div className="auth">You are not a member of any organisation.</div>;
  if (!privateKey) {
    return (
      <AuthShell title="Unlock" subtitle={<>Your encryption key is only kept in memory. Enter your password to decrypt your mail on this device.</>}>
        <form className="card" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError('');
          try { await unlock(password); } catch { setError('Wrong password'); } finally { setBusy(false); }
        }}>
          <label>Password for {me.user.email}</label>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
            <span className="grow" /><button type="button" className="btn" onClick={logout}>Sign out</button>
          </div>
        </form>
      </AuthShell>
    );
  }
  return <>{children}</>;
}
