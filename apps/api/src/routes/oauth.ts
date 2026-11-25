import express from 'express';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken } from '../crypto.js';
import { one, query } from '../db/pool.js';
import { assertWorkspace, requireAuth, requireRole } from '../auth/middleware.js';
import { encryptCredentials } from '../mail/credentials.js';
import { buildAuthUrl, exchangeCode, isConfigured, pkce, type OAuthProvider } from '../providers/oauth.js';
import { publishMailboxChange } from '../queue/index.js';
import { logger } from '../logger.js';
import { auth, h, parse } from './util.js';

export const oauthRouter = express.Router();
const providerParam = z.enum(['outlook', 'gmail']);

oauthRouter.get('/providers', (_req, res) => {
  res.json({ outlook: isConfigured('outlook'), gmail: isConfigured('gmail') });
});

/** Authenticated: returns the provider consent URL. The browser then navigates to it. */
oauthRouter.post('/:provider/start', requireAuth(), requireRole('owner', 'admin'), h(async (req, res) => {
  const provider = parse(providerParam, req.params.provider) as OAuthProvider;
  const { workspaceId } = parse(z.object({ workspaceId: z.string().uuid() }), req.body);
  await assertWorkspace(auth(req).orgId, workspaceId);
  const state = randomToken(24);
  const { verifier, challenge } = pkce();
  await query(
    `INSERT INTO oauth_states (state, organisation_id, user_id, workspace_id, provider, code_verifier_encrypted, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes')`,
    [state, auth(req).orgId, auth(req).userId, workspaceId, provider, encrypt(verifier)]);
  res.json({ url: buildAuthUrl(provider, state, challenge) });
}));

/** Public: provider redirects here. State is single-use and expires after 10 minutes. */
oauthRouter.get('/:provider/callback', h(async (req, res) => {
  const provider = parse(providerParam, req.params.provider) as OAuthProvider;
  const q = parse(z.object({ code: z.string().max(4000).optional(), state: z.string().max(100), error: z.string().max(200).optional() }), req.query);
  const back = (status: string) => res.redirect(`${config.WEB_ORIGIN}/settings?tab=mailboxes&oauth=${encodeURIComponent(status)}`);
  const st = await one<{ organisation_id: string; user_id: string; workspace_id: string; provider: string; code_verifier_encrypted: string }>(
    'DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING *', [q.state]);
  if (!st || st.provider !== provider) return back('invalid_state');
  if (q.error || !q.code) return back('denied');
  try {
    const t = await exchangeCode(provider, q.code, decrypt(st.code_verifier_encrypted));
    const creds = encryptCredentials({ kind: 'oauth', username: t.email, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
    const row = await one<{ id: string }>(
      `INSERT INTO mailboxes (organisation_id, workspace_id, provider, email_address, credentials_encrypted)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organisation_id, email_address) DO UPDATE SET credentials_encrypted = EXCLUDED.credentials_encrypted, provider = EXCLUDED.provider, sync_error = NULL, enabled = true
       RETURNING id`, [st.organisation_id, st.workspace_id, provider, t.email, creds]);
    await publishMailboxChange(row!.id);
    await audit(st.organisation_id, { type: 'user', userId: st.user_id }, 'mailbox.connect', { workspaceId: st.workspace_id, targetType: 'mailbox', targetId: row!.id, metadata: { provider } });
    return back('connected');
  } catch (err) {
    logger.warn({ provider, code: (err as { code?: string }).code }, 'oauth callback failed');
    return back('failed');
  }
}));
