'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  deriveKeys, open, openBytes, publicKeyFromPrivate, seal, unwrapSecret, type KdfParams,
} from '@inbox-os/shared';
import { api, loadStoredAuth, setAuth } from './api';

export interface OrgInfo { id: string; name: string; public_key: string; role: 'owner' | 'admin' | 'member'; wrapped_org_key: string }
export interface Me { user: { id: string; email: string; name: string; kdf_params: KdfParams }; organisations: OrgInfo[] }

interface SessionState {
  ready: boolean;
  me: Me | null;
  org: OrgInfo | null;
  /** Org private key, held in memory only. Lost on reload: the user re-enters their password. */
  privateKey: Uint8Array | null;
  login(email: string, password: string): Promise<void>;
  unlock(password: string): Promise<void>;
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

async function unwrapOrgKey(org: OrgInfo, wrapKey: Uint8Array): Promise<Uint8Array> {
  const pk = await unwrapSecret(org.wrapped_org_key, wrapKey);
  if ((await publicKeyFromPrivate(pk)) !== org.public_key) throw new Error('Organisation key mismatch');
  return pk;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [wrapKey, setWrapKey] = useState<Uint8Array | null>(null);
  const [privateKey, setPrivateKey] = useState<Uint8Array | null>(null);

  const org = useMemo(() => me?.organisations.find((o) => o.id === orgId) ?? me?.organisations[0] ?? null, [me, orgId]);

  const refresh = useCallback(async () => {
    const m = await api<Me>('/auth/me', { noOrg: true });
    setMe(m);
  }, []);

  useEffect(() => {
    const stored = loadStoredAuth();
    if (!stored.token) { setReady(true); return; }
    setOrgId(stored.orgId);
    refresh().catch(() => setAuth(null, null)).finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    if (!org || !wrapKey) { setPrivateKey(null); return; }
    setAuth(loadStoredAuth().token, org.id);
    unwrapOrgKey(org, wrapKey).then(setPrivateKey).catch(() => setPrivateKey(null));
  }, [org, wrapKey]);

  const login = useCallback(async (email: string, password: string) => {
    const pre = await api<{ kdf: KdfParams }>('/auth/prelogin', { body: { email } });
    const { authKey, wrapKey: wk } = await deriveKeys(password, pre.kdf);
    const r = await api<{ token: string }>('/auth/login', { body: { email, authKey } });
    setAuth(r.token, null);
    const m = await api<Me>('/auth/me', { noOrg: true });
    setMe(m);
    setOrgId(m.organisations[0]?.id ?? null);
    setAuth(r.token, m.organisations[0]?.id ?? null);
    setWrapKey(wk);
  }, []);

  const unlock = useCallback(async (password: string) => {
    if (!me) throw new Error('Not signed in');
    const { wrapKey: wk } = await deriveKeys(password, me.user.kdf_params);
    if (org) await unwrapOrgKey(org, wk); // throws on wrong password
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
    ready, me, org, privateKey, login, unlock, logout, refresh,
    switchOrg: (id) => { setOrgId(id); setAuth(loadStoredAuth().token, id); },
    seal: async (v) => { if (!org) throw new Error('No organisation'); return seal(v, org.public_key); },
    open: async <T,>(e: string) => { if (!org || !privateKey) throw new Error('Locked'); return open<T>(e, org.public_key, privateKey); },
    openBytes: async (e) => { if (!org || !privateKey) throw new Error('Locked'); return openBytes(e, org.public_key, privateKey); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
