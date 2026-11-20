import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * AES-256-GCM envelope with key IDs so keys can rotate:
 *   v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
 * New data is encrypted with the first key in ENCRYPTION_KEYS; any listed key can decrypt.
 */
type Keyring = { primary: string; keys: Map<string, Buffer> };

export function parseKeyring(spec: string): Keyring {
  const keys = new Map<string, Buffer>();
  let primary = '';
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx < 1) throw new Error('ENCRYPTION_KEYS entries must be "keyId:base64key"');
    const id = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes`);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid key id "${id}"`);
    keys.set(id, key);
    if (!primary) primary = id;
  }
  if (!primary) throw new Error('ENCRYPTION_KEYS is empty');
  return { primary, keys };
}

let ring: Keyring | null = null;
function keyring(): Keyring {
  if (!ring) ring = parseKeyring(config.ENCRYPTION_KEYS);
  return ring;
}

export function encrypt(plaintext: string, kr: Keyring = keyring()): string {
  const key = kr.keys.get(kr.primary)!;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', kr.primary, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob: string, kr: Keyring = keyring()): string {
  const [version, keyId, ivB64, tagB64, ctB64] = blob.split(':');
  if (version !== 'v1' || !keyId || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Malformed ciphertext');
  const key = kr.keys.get(keyId);
  if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}
export function decryptJson<T>(blob: string): T {
  return JSON.parse(decrypt(blob)) as T;
}

/** True when the blob was encrypted with a key other than the current primary (needs re-encryption). */
export function needsRotation(blob: string, kr: Keyring = keyring()): boolean {
  return blob.split(':')[1] !== kr.primary;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
