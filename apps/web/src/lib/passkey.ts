import { useEffect, useState } from 'react';
import { deriveKeyFromSecret, getSodium, toB64 } from '@inbox-os/shared';
import { api } from './api';

/**
 * Passkeys (WebAuthn) with the PRF extension. The authenticator returns a secret that only
 * exists on the user's device after Face ID / Touch ID / PIN. We derive a key from it to wrap
 * the organisation key, so a passkey both signs in and decrypts, with nothing readable server-side.
 */
const PRF_SALT = new TextEncoder().encode('inbox-os/passkey-prf/v1');

const enc = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const dec = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

async function keyFromPrf(cred: PublicKeyCredential): Promise<Uint8Array | null> {
  const first = (cred.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined;
  if (!first) return null;
  return deriveKeyFromSecret(await toB64(new Uint8Array(first)), 'passkey');
}

function friendly(err: unknown): Error {
  const e = err as { name?: string; message?: string };
  if (e.name === 'NotAllowedError') return new Error('Passkey request was cancelled.');
  if (e.name === 'InvalidStateError') return new Error('This device already has a passkey for this account.');
  return new Error(e.message ?? 'Passkey failed');
}

/** PRF output for an existing credential, using a local challenge (nothing is sent to the server). */
async function prfFor(credentialId: string): Promise<Uint8Array | null> {
  const s = await getSodium();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: s.randombytes_buf(32) as unknown as BufferSource, rpId: window.location.hostname, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: dec(credentialId) }],
      extensions: { prf: { eval: { first: PRF_SALT } } } as any,
    },
  })) as PublicKeyCredential | null;
  return cred ? keyFromPrf(cred) : null;
}

/** Create a passkey for the signed-in user. Returns its id and, when the device supports it, the wrapping key. */
export async function createPasskey(name: string): Promise<{ id: string; wrapKey: Uint8Array | null }> {
  try {
    const o = await api<any>('/auth/passkeys/register/options', { method: 'POST', noOrg: true });
    const cred = (await navigator.credentials.create({
      publicKey: {
        ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) },
        excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ ...c, id: dec(c.id) })),
        extensions: { ...(o.extensions ?? {}), prf: { eval: { first: PRF_SALT } } },
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error('No passkey was created');
    const r = cred.response as AuthenticatorAttestationResponse;
    const saved = await api<{ id: string; credentialId: string }>('/auth/passkeys/register/verify', {
      noOrg: true,
      body: {
        name,
        response: {
          id: cred.id, rawId: enc(cred.rawId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
          response: { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports?.() ?? [] },
        },
      },
    });
    // Some authenticators only release the PRF secret on a follow-up request.
    const wrapKey = (await keyFromPrf(cred)) ?? (await prfFor(saved.credentialId).catch(() => null));
    return { id: saved.id, wrapKey };
  } catch (err) { throw friendly(err); }
}

export interface PasskeyLogin { token: string; passkeyId: string; wrapKey: Uint8Array | null; wrappedOrgKeys: Record<string, string> }

export async function signInWithPasskey(): Promise<PasskeyLogin> {
  try {
    const o = await api<any>('/auth/passkeys/login/options', { method: 'POST', noOrg: true });
    const cred = (await navigator.credentials.get({
      publicKey: { challenge: dec(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeout, extensions: { prf: { eval: { first: PRF_SALT } } } as any },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error('No passkey was chosen');
    const r = cred.response as AuthenticatorAssertionResponse;
    const res = await api<{ token: string; passkeyId: string; wrappedOrgKeys: { organisation_id: string; wrapped_org_key: string }[] }>('/auth/passkeys/login/verify', {
      noOrg: true,
      body: {
        response: {
          id: cred.id, rawId: enc(cred.rawId), type: 'public-key', clientExtensionResults: {},
          response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: r.userHandle ? enc(r.userHandle) : undefined },
        },
      },
    });
    return { token: res.token, passkeyId: res.passkeyId, wrapKey: await keyFromPrf(cred), wrappedOrgKeys: Object.fromEntries(res.wrappedOrgKeys.map((k) => [k.organisation_id, k.wrapped_org_key])) };
  } catch (err) { throw friendly(err); }
}

/** True once mounted in a browser that supports passkeys (false during server render, avoiding hydration mismatches). */
export function usePasskeys(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => { setOk(passkeysSupported()); }, []);
  return ok;
}
