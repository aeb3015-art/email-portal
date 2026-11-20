import { fromB64, getSodium, openBytes, open, publicKeyFromPrivate, seal } from '@inbox-os/shared';
import { one, type Db } from './db/pool.js';
import { forbidden, notFound } from './errors.js';

/**
 * In-memory holder for unlocked organisation private keys.
 *
 * Keys arrive only when a signed-in user explicitly unlocks the agent from their browser.
 * They are kept in process memory with a TTL, are never written to disk, Redis, logs or
 * the database, and are wiped on lock, expiry or restart. A restart therefore re-locks
 * every organisation: agent, auto-send and session-based MCP fall back to "locked".
 */
interface Entry { key: Uint8Array; expiresAt: number; unlockedBy: string }
const unlocked = new Map<string, Entry>();

export async function orgPublicKey(orgId: string, db?: Db): Promise<string> {
  const row = await one<{ public_key: string }>('SELECT public_key FROM organisations WHERE id = $1', [orgId], db);
  if (!row) throw notFound('Organisation');
  return row.public_key;
}

export async function unlockOrg(orgId: string, privateKeyB64: string, ttlMinutes: number, userId: string): Promise<Date> {
  const key = await fromB64(privateKeyB64);
  const pub = await publicKeyFromPrivate(key);
  if (pub !== (await orgPublicKey(orgId))) throw forbidden('Key does not match this organisation');
  lockOrg(orgId);
  const expiresAt = Date.now() + ttlMinutes * 60_000;
  unlocked.set(orgId, { key, expiresAt, unlockedBy: userId });
  return new Date(expiresAt);
}

export function lockOrg(orgId: string): void {
  const e = unlocked.get(orgId);
  if (e) {
    e.key.fill(0);
    unlocked.delete(orgId);
  }
}

export function unlockStatus(orgId: string): { unlocked: boolean; expiresAt: string | null } {
  const e = getEntry(orgId);
  return { unlocked: !!e, expiresAt: e ? new Date(e.expiresAt).toISOString() : null };
}

function getEntry(orgId: string): Entry | null {
  const e = unlocked.get(orgId);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    lockOrg(orgId);
    return null;
  }
  return e;
}

/** Returns the unlocked private key, or null when the organisation is locked. */
export function sessionKey(orgId: string): Uint8Array | null {
  return getEntry(orgId)?.key ?? null;
}

/** A decryption context: either an unlocked session key or a request-scoped MCP token key. */
export class OrgCrypto {
  constructor(public orgId: string, public publicKey: string, private privateKey: Uint8Array | null) {}

  get canDecrypt(): boolean {
    return this.privateKey !== null;
  }

  seal(value: unknown): Promise<string> {
    return seal(value, this.publicKey);
  }

  async open<T>(envelope: string): Promise<T> {
    if (!this.privateKey) throw new LockedError();
    return open<T>(envelope, this.publicKey, this.privateKey);
  }

  async openBytes(envelope: string): Promise<Uint8Array> {
    if (!this.privateKey) throw new LockedError();
    return openBytes(envelope, this.publicKey, this.privateKey);
  }

  /** Wipe a request-scoped key. Never call on a shared session key. */
  async dispose(): Promise<void> {
    if (this.privateKey && !Array.from(unlocked.values()).some((e) => e.key === this.privateKey)) {
      (await getSodium()).memzero(this.privateKey);
    }
    this.privateKey = null;
  }
}

export class LockedError extends Error {
  status = 423;
  code = 'locked';
  constructor() {
    super('Organisation is locked: a member must unlock the agent from the web app before encrypted content can be read server-side.');
  }
}

export async function orgCrypto(orgId: string, db?: Db): Promise<OrgCrypto> {
  return new OrgCrypto(orgId, await orgPublicKey(orgId, db), sessionKey(orgId));
}

/** Test helper. */
export function _resetVault(): void {
  for (const id of [...unlocked.keys()]) lockOrg(id);
}
