'use client';
import Link from 'next/link';
import { useState } from 'react';
import { deriveKeyFromSecret, deriveKeys, newKdfParams, publicKeyFromPrivate, toB64, unwrapSecret, wrapSecret } from '@inbox-os/shared';
import { api } from '@/lib/api';

export default function RecoverPage() {
  const [f, setF] = useState({ email: '', recovery: '', password: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const email = f.email.trim().toLowerCase();
      const recoveryProof = await toB64(await deriveKeyFromSecret(f.recovery.trim(), 'recovery-proof'));
      const r = await api<{ recoveryWrappedKey: string; publicKey: string }>('/auth/recovery-key', { body: { email, recoveryProof } });
      const pk = await unwrapSecret(r.recoveryWrappedKey, await deriveKeyFromSecret(f.recovery.trim(), 'recovery'));
      if ((await publicKeyFromPrivate(pk)) !== r.publicKey) throw new Error('Recovery key does not match');
      const kdf = await newKdfParams();
      const { authKey, wrapKey } = await deriveKeys(f.password, kdf);
      await api('/auth/recover', { body: { email, recoveryProof, authKey, kdf, wrappedOrgKey: await wrapSecret(pk, wrapKey) } });
      setDone(true);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <h1>Recover your account</h1>
      <p className="muted small">Owners can recover with the recovery key shown at sign-up. Members: ask an admin to re-invite you. Without a key your encrypted data cannot be recovered, not even by us.</p>
      {done ? <div className="card">Password updated. <Link href="/login">Sign in</Link></div> : (
        <form className="card" onSubmit={submit}>
          <label>Email</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <label>Recovery key</label><input value={f.recovery} onChange={(e) => setF({ ...f, recovery: e.target.value })} required />
          <label>New password</label><input type="password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          {error && <div className="error">{error}</div>}
          <button className="btn primary" style={{ marginTop: 14 }} disabled={busy}>Reset password</button>
        </form>
      )}
    </div>
  );
}
