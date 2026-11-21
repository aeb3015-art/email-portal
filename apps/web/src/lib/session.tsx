'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  deriveKeys, getSodium, open, openBytes, publicKeyFromPrivate, seal, unwrapSecret, type KdfParams,
} from '@inbox-os/shared';
import { api, loadStoredAuth, setAuth } from './api';
import { createPasskey, signInWithPasskey } from './passkey';
import { wrapSecret } from '@inbox-os/shared';

export interface OrgInfo { id: string; name: string; public_key: string; role: 'owner' | 'admin' | 'member'; wrapped_org_key: string }
export interface Me { user: { id: string; email: string; name: string; kdf_params: KdfParams; has_password: boolean }; organisations: OrgInfo[] }

interface SessionState {
  ready: boolean;
  me: Me | null;
  org: OrgInfo | null;
  /** Org private key, held in memory only. Lost on reload: the user re-enters their password. */
  privateKey: Uint8Array | null;
  login(email: string, password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  /** Use a session the server just issued (after registering), with the wrap key derived on this device. */
  adopt(token: string, wrapKey: Uint8Array): Promise<void>;
  /** Sign in (or unlock) with a passkey: Face ID, Touch ID or device PIN. */
  loginWithPasskey(): Promise<void>;
  /** Add a passkey to this account. Returns false when the device can sign in but cannot unlock encryption. */
  addPasskey(name: string): Promise<boolean>;
  logout(): Promise<void>;
  switchOrg(id: string): void;
  seal(value: unknown): Promise<string>;
  open<T>(envelope: string): Promise<T>;
  openBytes(envelope: string): Promise<Uint8Array>;
  refresh(): Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);
export const useSession = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
};

async function unwrapOrgKey(org: OrgInfo, wrapKey: Uint8Array, wrapped: string = org.wrapped_org_key): Promise<Uint8Array> {
  const pk = await unwrapSecret(wrapped, wrapKey);
  if ((await publicKeyFromPrivate(pk)) !== org.public_key) throw new Error('Organisation key mismatch');
  return pk;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [wrapKey, setWrapKey] = useState<Uint8Array | null>(null);
  // When signed in with a passkey, org keys are wrapped by the passkey secret instead of the password.
  const [passkeyWrapped, setPasskeyWrapped] = useState<Record<string, string> | null>(null);
  const [privateKey, setPrivateKey] = useState<Uint8Array | null>(null);

  const org = useMemo(() => me?.organisations.find((o) => o.id === orgId) ?? me?.organisations[0] ?? null, [me, orgId]);

  const refresh = useCallback(async () => {
    const m = await api<Me>('/auth/me', { noOrg: true });
    setMe(m);
  }, []);

  // Warm up the crypto library after first paint so sign-in and decryption start instantly.
  useEffect(() => { const t = setTimeout(() => { getSodium().catch(() => undefined); }, 150); return () => clearTimeout(t); }, []);

  useEffect(() => {
    const stored = loadStoredAuth();
    if (!stored.token) { setReady(true); return; }
    setOrgId(stored.orgId);
    refresh().catch(() => setAuth(null, null)).finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    if (!org || !wrapKey) { setPrivateKey(null); return; }
    setAuth(loadStoredAuth().token, org.id);
    const wrapped = passkeyWrapped ? passkeyWrapped[org.id] : org.wrapped_org_key;
    if (!wrapped) { setPrivateKey(null); return; }
    unwrapOrgKey(org, wrapKey, wrapped).then(setPrivateKey).catch(() => setPrivateKey(null));
  }, [org, wrapKey, passkeyWrapped]);

  const login = useCallback(async (email: string, password: string) => {
    const pre = await api<{ kdf: KdfParams }>('/auth/prelogin', { body: { email } });
    const { authKey, wrapKey: wk } = await deriveKeys(password, pre.kdf);
    const r = await api<{ token: string }>('/auth/login', { body: { email, authKey } });
    setAuth(r.token, null);
    const m = await api<Me>('/auth/me', { noOrg: true });
    setMe(m);
    setOrgId(m.organisations[0]?.id ?? null);
    setAuth(r.token, m.organisations[0]?.id ?? null);
    setPasskeyWrapped(null);
    setWrapKey(wk);
  }, []);

  const adopt = useCallback(async (token: string, wk: Uint8Array) => {
    setAuth(token, null);
    const m = await api<Me>('/auth/me', { noOrg: true });
    setMe(m);
    setOrgId(m.organisations[0]?.id ?? null);
    setAuth(token, m.organisations[0]?.id ?? null);
    setPasskeyWrapped(null);
    setWrapKey(wk);
  }, []);

  const loginWithPasskey = useCallback(async () => {
    const r = await signInWithPasskey();
    const keepOrg = loadStoredAuth().orgId;
    setAuth(r.token, null);
    const m = await api<Me>('/auth/me', { noOrg: true });
    const first = m.organisations.find((o) => o.id === keepOrg)?.id ?? m.organisations.find((o) => r.wrappedOrgKeys[o.id])?.id ?? m.organisations[0]?.id ?? null;
    setMe(m); setOrgId(first); setAuth(r.token, first);
    if (!r.wrapKey || !Object.keys(r.wrappedOrgKeys).length) {
      throw new Error('Signed in, but this passkey cannot unlock your encrypted mail on this device. Enter your password to unlock.');
    }
    setPasskeyWrapped(r.wrappedOrgKeys);
    setWrapKey(r.wrapKey);
  }, []);

  const addPasskey = useCallback(async (name: string) => {
    if (!org || !privateKey) throw new Error('Unlock first');
    const created = await createPasskey(name);
    if (!created.wrapKey) return false;
    await api(`/auth/passkeys/${created.id}/keys`, { method: 'PUT', noOrg: true, body: { wrappedOrgKeys: [{ organisationId: org.id, wrappedOrgKey: await wrapSecret(privateKey, created.wrapKey) }] } });
    return true;
  }, [org, privateKey]);

  const unlock = useCallback(async (password: string) => {
    if (!me) throw new Error('Not signed in');
    const { wrapKey: wk } = await deriveKeys(password, me.user.kdf_params);
    if (org) await unwrapOrgKey(org, wk); // throws on wrong password
    setPasskeyWrapped(null);
    setWrapKey(wk);
  }, [me, org]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', noOrg: true }).catch(() => undefined);
    privateKey?.fill(0);
    setAuth(null, null);
    setMe(null); setWrapKey(null); setPrivateKey(null);
    window.location.href = '/login';
  }, [privateKey]);

  const value: SessionState = {
    ready, me, org, privateKey, login, unlock, logout, refresh, loginWithPasskey, addPasskey, adopt,
    switchOrg: (id) => { setOrgId(id); setAuth(loadStoredAuth().token, id); },
    seal: async (v) => { if (!org) throw new Error('No organisation'); return seal(v, org.public_key); },
    open: async <T,>(e: string) => { if (!org || !privateKey) throw new Error('Locked'); return open<T>(e, org.public_key, privateKey); },
    openBytes: async (e) => { if (!org || !privateKey) throw new Error('Locked'); return openBytes(e, org.public_key, privateKey); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
