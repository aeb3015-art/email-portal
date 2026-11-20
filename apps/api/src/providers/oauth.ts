import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

/**
 * OAuth for Outlook / Microsoft 365 and Gmail. Both providers expose IMAP + SMTP with
 * XOAUTH2, so OAuth mailboxes reuse the same sync engine as password IMAP mailboxes.
 *
 * Gmail: the https://mail.google.com/ scope is "restricted". Before a public launch Google
 * requires a paid CASA security assessment. Until then, use Gmail via IMAP + app password,
 * or keep the OAuth app in "testing" mode with named test users.
 */
export type OAuthProvider = 'outlook' | 'gmail';

const PROVIDERS = {
  outlook: {
    authUrl: () => `https://login.microsoftonline.com/${config.MICROSOFT_TENANT}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${config.MICROSOFT_TENANT}/oauth2/v2.0/token`,
    scope: 'openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    clientId: () => config.MICROSOFT_CLIENT_ID,
    clientSecret: () => config.MICROSOFT_CLIENT_SECRET,
    extra: {} as Record<string, string>,
  },
  gmail: {
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://mail.google.com/',
    clientId: () => config.GOOGLE_CLIENT_ID,
    clientSecret: () => config.GOOGLE_CLIENT_SECRET,
    extra: { access_type: 'offline', prompt: 'consent' } as Record<string, string>,
  },
};

export const redirectUri = (p: OAuthProvider) => `${config.PUBLIC_API_URL}/oauth/${p}/callback`;

export function isConfigured(p: OAuthProvider): boolean {
  return !!(PROVIDERS[p].clientId() && PROVIDERS[p].clientSecret());
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl(p: OAuthProvider, state: string, challenge: string): string {
  const def = PROVIDERS[p];
  if (!isConfigured(p)) throw new HttpError(400, `${p} OAuth is not configured on this server`, 'not_configured');
  const params = new URLSearchParams({
    client_id: def.clientId()!,
    response_type: 'code',
    redirect_uri: redirectUri(p),
    scope: def.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...def.extra,
  });
  return `${def.authUrl()}?${params}`;
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; id_token?: string }

async function tokenRequest(p: OAuthProvider, body: Record<string, string>): Promise<TokenResponse> {
  const def = PROVIDERS[p];
  const res = await fetch(def.tokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: def.clientId()!, client_secret: def.clientSecret()!, ...body }),
  });
  if (!res.ok) throw new HttpError(502, `${p} token endpoint returned ${res.status}`, 'oauth_failed');
  return (await res.json()) as TokenResponse;
}

function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8'));
    return (payload.email ?? payload.preferred_username ?? null)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export async function exchangeCode(p: OAuthProvider, code: string, verifier: string) {
  const t = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(p), code_verifier: verifier });
  if (!t.refresh_token) throw new HttpError(502, 'Provider did not return a refresh token', 'oauth_failed');
  const email = emailFromIdToken(t.id_token);
  if (!email) throw new HttpError(502, 'Could not determine mailbox address from provider', 'oauth_failed');
  return { email, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

export async function refreshOAuthToken(p: OAuthProvider, refreshToken: string) {
  const t = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: PROVIDERS[p].scope });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
}
