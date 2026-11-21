'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deriveKeyFromSecret, deriveKeys, generateOrgKeypair, getSodium, newKdfParams, toB64, unwrapSecret, wrapSecret, type KdfParams } from '@inbox-os/shared';
import { AuthShell, Icon } from '@/components/ui';
import { api } from '@/lib/api';
import { usePasskeys } from '@/lib/passkey';
import { useSession } from '@/lib/session';

type Step = 'form' | 'passkey' | 'fallback' | 'recovery';

export default function RegisterPage() {
  const s = useSession();
  const router = useRouter();
  const hasPasskeys = usePasskeys();
  useEffect(() => { if (hasPasskeys) setMode('passkey'); }, [hasPasskeys]);
  const [mode, setMode] = useState<'passkey' | 'password'>('password');
  const [f, setF] = useState({ name: '', email: '', organisationName: '', password: '' });
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [saved, setSaved] = useState(false);
  // For passkey sign-up: a random secret stands in for the password and is thrown away afterwards.
  const [temp, setTemp] = useState<{ secret: string; kdf: KdfParams } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const email = f.email.trim().toLowerCase();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'password' && f.password.length < 10) return setError('Use at least 10 characters for your password.');
    setBusy(true);
    try {
      const sodium = await getSodium();
      const secret = mode === 'password' ? f.password : await toB64(sodium.randombytes_buf(32));
      const kdf = await newKdfParams();
      const { authKey, wrapKey } = await deriveKeys(secret, kdf);
      const org = await generateOrgKeypair();
      const recovery = await toB64(sodium.randombytes_buf(32));
      const reg = await api<{ token: string }>('/auth/register', {
        body: {
          email, name: f.name, organisationName: f.organisationName, authKey, kdf, passwordless: mode === 'passkey',
          orgPublicKey: org.publicKey,
          wrappedOrgKey: await wrapSecret(org.privateKey, wrapKey),
          recoveryWrappedOrgKey: await wrapSecret(org.privateKey, await deriveKeyFromSecret(recovery, 'recovery')),
          recoveryProof: await toB64(await deriveKeyFromSecret(recovery, 'recovery-proof')),
        },
      });
      sodium.memzero(org.privateKey);
      setRecoveryKey(recovery);
      // Registering already returns a session; adopt it with the key we just derived.
      await s.adopt(reg.token, wrapKey);
      if (mode === 'passkey') { setTemp({ secret, kdf }); setStep('passkey'); } else setStep('recovery');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function makePasskey() {
    setBusy(true); setError('');
    try {
      const ok = await s.addPasskey(navigator.platform || 'This device');
      if (ok) setStep('recovery'); else { setError('This device can create a passkey but cannot use it to unlock encrypted mail. Set a password instead.'); setStep('fallback'); }
    } catch (err) {
      setError(`${(err as Error).message} You can try again, or set a password instead.`);
    } finally { setBusy(false); }
  }

  async function setPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!temp) return;
    if (newPassword.length < 10) return setError('Use at least 10 characters.');
    setBusy(true); setError('');
    try {
      const cur = await deriveKeys(temp.secret, temp.kdf);
      const kdf = await newKdfParams();
      const next = await deriveKeys(newPassword, kdf);
      const wrappedOrgKeys = await Promise.all(s.me!.organisations.map(async (o) => ({ organisationId: o.id, wrappedOrgKey: await wrapSecret(await unwrapSecret(o.wrapped_org_key, cur.wrapKey), next.wrapKey) })));
      await api('/auth/change-password', { noOrg: true, body: { currentAuthKey: cur.authKey, authKey: next.authKey, kdf, wrappedOrgKeys } });
      await s.login(email, newPassword);
      setStep('recovery');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (step === 'passkey') {
    return (
      <AuthShell title="Create your passkey" subtitle={<>Use Face ID, Touch ID or your device PIN. Your passkey signs you in and unlocks your encrypted mail, so there is no password to remember.</>}>
        <button className="btn primary wide" disabled={busy || !s.privateKey} onClick={makePasskey}><Icon name="key" size={16} /> {busy ? 'Waiting for your device…' : 'Create passkey'}</button>
        {error && <div className="error">{error}</div>}
        <div className="or"><span>or</span></div>
        <button className="btn wide" onClick={() => { setError(''); setStep('fallback'); }}>Set a password instead</button>
      </AuthShell>
    );
  }

  if (step === 'fallback') {
    return (
      <AuthShell title="Set a password" subtitle={<>Your password never leaves this device. It unlocks your encryption key locally.</>}>
        <form onSubmit={setPassword}>
          <label>Password</label>
          <input type="password" autoComplete="new-password" autoFocus value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <button className="btn primary wide" style={{ marginTop: 14 }} disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
      </AuthShell>
    );
  }

  if (step === 'recovery') {
    return (
      <AuthShell title="Save your recovery key" subtitle={<>Inbox OS cannot read your mail and cannot reset your access. If you lose your passkey or password, this key is the only way back in. Store it in a password manager. It will not be shown again.</>}>
        <div className="code">{recoveryKey}</div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => navigator.clipboard.writeText(recoveryKey)}>Copy</button>
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved it</label>
          <span className="grow" />
          <button className="btn primary" disabled={!saved} onClick={() => router.push('/settings')}>Continue</button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle={<>Keys are generated on your device. The server stores only encrypted data it cannot read.</>}>
      <form onSubmit={create}>
        <label>Your name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" />
        <label>Email</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="email" />
        <label>Organisation name</label><input value={f.organisationName} onChange={(e) => setF({ ...f, organisationName: e.target.value })} required />
        {mode === 'password' && (<>
          <label>Password</label><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        </>)}
        {error && <div className="error">{error}</div>}
        <button className="btn primary wide" style={{ marginTop: 16 }} disabled={busy}>
          {mode === 'passkey' && <Icon name="key" size={16} />} {busy ? 'Creating your account…' : mode === 'passkey' ? 'Continue with a passkey' : 'Create account'}
        </button>
        <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
          {hasPasskeys
            ? <a className="small" onClick={() => setMode(mode === 'passkey' ? 'password' : 'passkey')}>{mode === 'passkey' ? 'Use a password instead' : 'Use a passkey instead'}</a>
            : <span />}
          <Link className="small" href="/login">Sign in instead</Link>
        </div>
      </form>
    </AuthShell>
  );
}
