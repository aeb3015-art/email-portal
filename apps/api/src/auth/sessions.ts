import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { randomToken, sha256 } from '../crypto.js';

export const hashAuthKey = (authKey: string) => bcrypt.hash(authKey, 12);
export const verifyAuthKey = (authKey: string, hash: string) => bcrypt.compare(authKey, hash);

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = `ses_${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
  await query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [userId, sha256(token), expiresAt]);
  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<{ userId: string } | null> {
  const row = await one<{ user_id: string }>('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
  return row ? { userId: row.user_id } : null;
}

export async function revokeSession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Deterministic fake KDF params for unknown emails so prelogin doesn't reveal which accounts exist. */
export function fakeKdfParams(email: string) {
  const salt = crypto.createHmac('sha256', config.ENCRYPTION_KEYS).update(`kdf:${email}`).digest().subarray(0, 16).toString('base64url');
  return { salt, opsLimit: 2, memLimit: 67108864 };
}
