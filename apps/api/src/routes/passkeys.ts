import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { HttpError, notFound } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { createSession } from '../auth/sessions.js';
import { auth, h, parse } from './util.js';

export const passkeyRouter = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
passkeyRouter.use(limiter);

/** The relying party is the web app the request came from, which must be an allowed origin. */
function relyingParty(req: Request): { origin: string; rpID: string } {
  const origin = String(req.headers.origin ?? '');
  const allowed = config.WEB_ORIGIN.split(',').map((s) => s.trim());
  if (!allowed.includes(origin)) throw new HttpError(403, 'Origin not allowed for passkeys', 'forbidden');
  return { origin, rpID: new URL(origin).hostname };
}

function challengeOf(response: { response?: { clientDataJSON?: string } }): string {
  try {
    return JSON.parse(Buffer.from(response.response!.clientDataJSON!, 'base64url').toString('utf8')).challenge;
  } catch {
    throw new HttpError(400, 'Malformed passkey response', 'bad_request');
  }
}

async function consumeChallenge(challenge: string, kind: 'register' | 'login'): Promise<{ user_id: string | null }> {
  await query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  const row = await one<{ user_id: string | null }>('DELETE FROM webauthn_challenges WHERE challenge = $1 AND kind = $2 AND expires_at > now() RETURNING user_id', [challenge, kind]);
  if (!row) throw new HttpError(400, 'Passkey request expired, please try again', 'challenge_expired');
  return row;
}

const responseSchema = z.object({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.record(z.any()) }).passthrough();
const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/).max(4096);
const wrappedKeys = z.array(z.object({ organisationId: z.string().uuid(), wrappedOrgKey: b64 })).min(1).max(100);

// ---------- Add a passkey to the signed-in account ----------
passkeyRouter.post('/register/options', requireAuth({ org: false }), h(async (req, res) => {
  const { rpID } = relyingParty(req);
  const user = await one<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users WHERE id = $1', [auth(req).userId]);
  const existing = (await query<{ credential_id: string }>('SELECT credential_id FROM passkeys WHERE user_id = $1', [user!.id])).rows;
  const options = await generateRegistrationOptions({
    rpName: 'Inbox OS', rpID, userName: user!.email, userDisplayName: user!.name, userID: new TextEncoder().encode(user!.id),
    attestationType: 'none', excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await query(`INSERT INTO webauthn_challenges (challenge, user_id, kind, expires_at) VALUES ($1,$2,'register', now() + interval '5 minutes')`, [options.challenge, user!.id]);
  res.json(options);
}));

passkeyRouter.post('/register/verify', requireAuth({ org: false }), h(async (req, res) => {
  const { origin, rpID } = relyingParty(req);
  const b = parse(z.object({ response: responseSchema, name: z.string().trim().max(60).optional() }), req.body);
  const ch = await consumeChallenge(challengeOf(b.response), 'register');
  if (ch.user_id !== auth(req).userId) throw new HttpError(403, 'Challenge does not belong to this user', 'forbidden');
  const v = await verifyRegistrationResponse({ response: b.response as any, expectedChallenge: challengeOf(b.response), expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'Passkey could not be verified', 'bad_request');
  const c = v.registrationInfo.credential;
  const row = await one<{ id: string }>(
    'INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [auth(req).userId, c.id, Buffer.from(c.publicKey), c.counter, (b.response.response as any).transports ?? [], b.name || 'Passkey']);
  res.status(201).json({ id: row!.id, credentialId: c.id });
}));

/** Store the org keys wrapped by this passkey's browser-side PRF secret. */
passkeyRouter.put('/:id/keys', requireAuth({ org: false }), h(async (req, res) => {
  const b = parse(z.object({ wrappedOrgKeys: wrappedKeys }), req.body);
  const pk = await one<{ id: string }>('SELECT id FROM passkeys WHERE id = $1 AND user_id = $2', [req.params.id, auth(req).userId]);
  if (!pk) throw notFound('Passkey');
  const mine = new Set((await query<{ organisation_id: string }>('SELECT organisation_id FROM memberships WHERE user_id = $1', [auth(req).userId])).rows.map((r) => r.organisation_id));
  await tx(async (db) => {
    for (const w of b.wrappedOrgKeys) {
      if (!mine.has(w.organisationId)) throw new HttpError(403, 'Not a member of that organisation', 'forbidden');
      await db.query(`INSERT INTO passkey_org_keys (passkey_id, organisation_id, wrapped_org_key) VALUES ($1,$2,$3)
        ON CONFLICT (passkey_id, organisation_id) DO UPDATE SET wrapped_org_key = EXCLUDED.wrapped_org_key`, [pk.id, w.organisationId, w.wrappedOrgKey]);
    }
  });
  for (const id of mine) await audit(id, { type: 'user', userId: auth(req).userId }, 'passkey.add');
  res.status(204).end();
}));

passkeyRouter.get('/', requireAuth({ org: false }), h(async (req, res) => {
  const rows = (await query(
    `SELECT p.id, p.name, p.created_at, p.last_used_at, EXISTS (SELECT 1 FROM passkey_org_keys k WHERE k.passkey_id = p.id) AS can_unlock
     FROM passkeys p WHERE p.user_id = $1 ORDER BY p.created_at`, [auth(req).userId])).rows;
  res.json({ passkeys: rows });
}));

passkeyRouter.delete('/:id', requireAuth({ org: false }), h(async (req, res) => {
  const u = await one<{ has_password: boolean; n: number }>(
    'SELECT u.has_password, (SELECT count(*)::int FROM passkeys WHERE user_id = u.id) AS n FROM users u WHERE u.id = $1', [auth(req).userId]);
  if (!u!.has_password && u!.n <= 1) throw new HttpError(409, 'This is your only way to sign in. Add another passkey or set a password first.', 'conflict');
  const r = await query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [req.params.id, auth(req).userId]);
  if (!r.rowCount) throw notFound('Passkey');
  res.status(204).end();
}));

// ---------- Sign in with a passkey (no email needed) ----------
passkeyRouter.post('/login/options', h(async (req, res) => {
  const { rpID } = relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  await query(`INSERT INTO webauthn_challenges (challenge, kind, expires_at) VALUES ($1,'login', now() + interval '5 minutes')`, [options.challenge]);
  res.json(options);
}));

passkeyRouter.post('/login/verify', h(async (req, res) => {
  const { origin, rpID } = relyingParty(req);
  const b = parse(z.object({ response: responseSchema }), req.body);
  const challenge = challengeOf(b.response);
  await consumeChallenge(challenge, 'login');
  const pk = await one<{ id: string; user_id: string; credential_id: string; public_key: Buffer; counter: number; transports: string[] }>(
    'SELECT id, user_id, credential_id, public_key, counter, transports FROM passkeys WHERE credential_id = $1', [b.response.id]);
  if (!pk) throw new HttpError(401, 'This passkey is not registered', 'unauthorized');
  const v = await verifyAuthenticationResponse({
    response: b.response as any, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: pk.transports as any },
  }).catch(() => null);
  if (!v?.verified) throw new HttpError(401, 'Passkey verification failed', 'unauthorized');
  await query('UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1', [pk.id, v.authenticationInfo.newCounter]);
  const session = await createSession(pk.user_id);
  const keys = (await query('SELECT organisation_id, wrapped_org_key FROM passkey_org_keys WHERE passkey_id = $1', [pk.id])).rows;
  res.json({ token: session.token, expiresAt: session.expiresAt, userId: pk.user_id, passkeyId: pk.id, wrappedOrgKeys: keys });
}));
