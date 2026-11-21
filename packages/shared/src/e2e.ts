/**
 * Zero-access encryption primitives, shared by browser and server.
 *
 * Model:
 *  - Each organisation has an X25519 keypair. The server stores ONLY the public key.
 *  - Anyone holding the public key (e.g. the sync worker) can seal data; only holders of
 *    the private key (users' browsers, or an explicitly unlocked API session) can open it.
 *  - The private key is wrapped (XSalsa20-Poly1305 secretbox) by keys the server never sees:
 *    each user's password-derived wrap key, a recovery key, and per-MCP-token keys.
 *  - Login: the browser derives a master key from the password with Argon2id, then splits it
 *    into an `authKey` (sent to the server, which hashes it again) and a `wrapKey` (never sent).
 *
 * Envelope format for sealed records (string):
 *   "e1:" + base64url( sealed_box(contentKey) ) + ":" + base64url( nonce || secretbox(json, contentKey) )
 */
import type _sodium from 'libsodium-wrappers-sumo';

export type Sodium = typeof _sodium;
let sodiumPromise: Promise<Sodium> | null = null;

/** Loaded on first use so the (large) crypto library never blocks the first paint. */
export function getSodium(): Promise<Sodium> {
  if (!sodiumPromise) {
    sodiumPromise = import('libsodium-wrappers-sumo').then(async (m) => {
      const lib = ((m as { default?: Sodium }).default ?? m) as Sodium;
      await lib.ready;
      return lib;
    });
  }
  return sodiumPromise;
}

export async function toB64(bytes: Uint8Array): Promise<string> {
  const s = await getSodium();
  return s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
}
export async function fromB64(str: string): Promise<Uint8Array> {
  const s = await getSodium();
  return s.from_base64(str, s.base64_variants.URLSAFE_NO_PADDING);
}

// ---------------- Key derivation ----------------

export interface KdfParams {
  salt: string; // base64url, 16 bytes
  opsLimit: number;
  memLimit: number;
}

export async function newKdfParams(): Promise<KdfParams> {
  const s = await getSodium();
  return {
    salt: await toB64(s.randombytes_buf(s.crypto_pwhash_SALTBYTES)),
    opsLimit: s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memLimit: s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  };
}

export interface DerivedKeys {
  /** Sent to the server as the login credential. Reveals nothing about wrapKey. */
  authKey: string;
  /** Never leaves the client. Wraps the organisation private key. */
  wrapKey: Uint8Array;
}

export async function deriveKeys(password: string, params: KdfParams): Promise<DerivedKeys> {
  const s = await getSodium();
  const master = s.crypto_pwhash(
    32,
    password,
    await fromB64(params.salt),
    params.opsLimit,
    params.memLimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
  const authKey = s.crypto_generichash(32, s.from_string('inbox-os/auth/v1'), master);
  const wrapKey = s.crypto_generichash(32, s.from_string('inbox-os/wrap/v1'), master);
  s.memzero(master);
  return { authKey: await toB64(authKey), wrapKey };
}

/** Key derived from a high-entropy secret (recovery key, MCP token). No Argon2 needed. */
export async function deriveKeyFromSecret(secret: string, purpose: string): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_generichash(32, s.from_string(`inbox-os/${purpose}/v1:${secret}`));
}

// ---------------- Org keypair ----------------

export interface OrgKeypair {
  publicKey: string; // base64url
  privateKey: Uint8Array;
}

export async function generateOrgKeypair(): Promise<OrgKeypair> {
  const s = await getSodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: await toB64(kp.publicKey), privateKey: kp.privateKey };
}

export async function publicKeyFromPrivate(privateKey: Uint8Array): Promise<string> {
  const s = await getSodium();
  return toB64(s.crypto_scalarmult_base(privateKey));
}

/** Wrap a secret (e.g. org private key) with a symmetric key. Output: base64url(nonce||box). */
export async function wrapSecret(secret: Uint8Array, key: Uint8Array): Promise<string> {
  const s = await getSodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const box = s.crypto_secretbox_easy(secret, nonce, key);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return toB64(out);
}

export async function unwrapSecret(wrapped: string, key: Uint8Array): Promise<Uint8Array> {
  const s = await getSodium();
  const raw = await fromB64(wrapped);
  const nonce = raw.slice(0, s.crypto_secretbox_NONCEBYTES);
  const box = raw.slice(s.crypto_secretbox_NONCEBYTES);
  try {
    return s.crypto_secretbox_open_easy(box, nonce, key);
  } catch {
    throw new Error('Unable to unwrap key (wrong password or corrupted data)');
  }
}

// ---------------- Sealed records ----------------

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('e1:');
}

export async function sealBytes(data: Uint8Array, publicKeyB64: string): Promise<string> {
  const s = await getSodium();
  const contentKey = s.crypto_secretbox_keygen();
  const sealedKey = s.crypto_box_seal(contentKey, await fromB64(publicKeyB64));
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const box = s.crypto_secretbox_easy(data, nonce, contentKey);
  s.memzero(contentKey);
  const body = new Uint8Array(nonce.length + box.length);
  body.set(nonce);
  body.set(box, nonce.length);
  return `e1:${await toB64(sealedKey)}:${await toB64(body)}`;
}

export async function openBytes(envelope: string, publicKeyB64: string, privateKey: Uint8Array): Promise<Uint8Array> {
  const s = await getSodium();
  const [tag, sealedKeyB64, bodyB64] = envelope.split(':');
  if (tag !== 'e1' || !sealedKeyB64 || !bodyB64) throw new Error('Malformed envelope');
  const contentKey = s.crypto_box_seal_open(await fromB64(sealedKeyB64), await fromB64(publicKeyB64), privateKey);
  const body = await fromB64(bodyB64);
  const nonce = body.slice(0, s.crypto_secretbox_NONCEBYTES);
  const out = s.crypto_secretbox_open_easy(body.slice(s.crypto_secretbox_NONCEBYTES), nonce, contentKey);
  s.memzero(contentKey);
  return out;
}

export async function seal(value: unknown, publicKeyB64: string): Promise<string> {
  const s = await getSodium();
  return sealBytes(s.from_string(JSON.stringify(value)), publicKeyB64);
}

export async function open<T>(envelope: string, publicKeyB64: string, privateKey: Uint8Array): Promise<T> {
  const s = await getSodium();
  return JSON.parse(s.to_string(await openBytes(envelope, publicKeyB64, privateKey))) as T;
}

// ---------------- Sealed payload shapes ----------------

export interface SealedMessage {
  /** Original header values, kept sealed; needed to build In-Reply-To/References on reply. */
  messageId: string | null;
  references: string[];
  subject: string;
  fromAddress: string;
  fromName: string;
  to: string[];
  cc: string[];
  text: string;
  html: string | null;
  snippet: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

export interface SealedThreadSummary {
  subject: string;
  snippet: string;
  participants: string[];
}

export interface SealedDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  inReplyTo?: string | null;
  references?: string[];
  /** Agent's rationale shown to the approver. */
  note?: string;
}

export interface SealedVoiceProfile {
  tone: string;
  signature: string;
  sampleText: string;
  language: string;
}

export interface SealedKnowledgeItem {
  title: string;
  content: string;
}

export interface SealedAgentInstructions {
  instructions: string;
}
