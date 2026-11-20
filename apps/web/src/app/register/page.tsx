'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deriveKeyFromSecret, deriveKeys, generateOrgKeypair, getSodium, newKdfParams, toB64, wrapSecret } from '@inbox-os/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function RegisterPage() {
  const { login } = useSession();
  const router = useRouter();
  const [f, setF] = useState({ name: '', email: '', organisationName: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (f.password.length < 10) return setError('Use at least 10 characters.');
    if (f.password !== f.confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      const s = await getSodium();
      const kdf = await newKdfParams();
      const { authKey, wrapKey } = await deriveKeys(f.password, kdf);
      const org = await generateOrgKeypair();
      const recovery = await toB64(s.randombytes_buf(32));
      await api('/auth/register', {
        body: {
          email: f.email.trim().toLowerCase(), name: f.name, organisationName: f.organisationName, authKey, kdf,
          orgPublicKey: org.publicKey,
          wrappedOrgKey: await wrapSecret(org.privateKey, wrapKey),
          recoveryWrappedOrgKey: await wrapSecret(org.privateKey, await deriveKeyFromSecret(recovery, 'recovery')),
          recoveryProof: await toB64(await deriveKeyFromSecret(recovery, 'recovery-proof')),
        },
      });
      s.memzero(org.privateKey);
      setRecoveryKey(recovery);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  if (recoveryKey) {
    return (
      <div className="auth">
        <h1>Save your recovery key</h1>
        <p className="muted small">Inbox OS cannot read your mail and cannot reset your password. If you forget your password, this key is the only way back in. Store it in a password manager. It will not be shown again.</p>
        <div className="code">{recoveryKey}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => navigator.clipboard.writeText(recoveryKey)}>Copy</button>
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved it</label>
          <span className="grow" />
          <button className="btn primary" disabled={!saved} onClick={async () => { await login(f.email.trim().toLowerCase(), f.password); router.push('/settings'); }}>Continue</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1>Create your organisation</h1>
      <p className="muted small">Keys are generated in your browser. The server stores only encrypted data it cannot read.</p>
      <form className="card" onSubmit={submit}>
        <label>Your name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <label>Email</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <label>Organisation name</label><input value={f.organisationName} onChange={(e) => setF({ ...f, organisationName: e.target.value })} required />
        <label>Password</label><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        <label>Confirm password</label><input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required />
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy}>{busy ? 'Generating keys…' : 'Create account'}</button>
          <span className="grow" /><Link className="small" href="/login">Sign in instead</Link>
        </div>
      </form>
    </div>
  );
}
