import { describe, expect, it } from 'vitest';
import { deriveKeys, deriveKeyFromSecret, generateOrgKeypair, open, publicKeyFromPrivate, seal, unwrapSecret, wrapSecret } from '@inbox-os/shared';
import { decrypt, encrypt, needsRotation, parseKeyring } from './crypto.js';
import { TEST_KDF } from './test/helpers.js';

describe('server-side AES-256-GCM (mailbox credentials)', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('hunter2');
    const b = encrypt('hunter2');
    expect(a).not.toEqual(b);
    expect(decrypt(a)).toBe('hunter2');
  });
  it('supports key rotation: old key still decrypts, new data uses primary', () => {
    const k1 = Buffer.alloc(32, 1).toString('base64');
    const k2 = Buffer.alloc(32, 2).toString('base64');
    const old = parseKeyring(`k1:${k1}`);
    const rotated = parseKeyring(`k2:${k2},k1:${k1}`);
    const blob = encrypt('secret', old);
    expect(decrypt(blob, rotated)).toBe('secret');
    expect(needsRotation(blob, rotated)).toBe(true);
    expect(needsRotation(encrypt('x', rotated), rotated)).toBe(false);
  });
  it('rejects tampered ciphertext', () => {
    const blob = encrypt('secret').split(':');
    blob[4] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(blob.join(':'))).toThrow();
  });
});

describe('zero-access envelope', () => {
  it('seals with the public key only and opens only with the private key', async () => {
    const kp = await generateOrgKeypair();
    const other = await generateOrgKeypair();
    const env = await seal({ subject: 'Blue Card' }, kp.publicKey);
    expect(env).not.toContain('Blue Card');
    expect(await open(env, kp.publicKey, kp.privateKey)).toEqual({ subject: 'Blue Card' });
    await expect(open(env, other.publicKey, other.privateKey)).rejects.toThrow();
  });
  it('password-derived authKey is independent of wrapKey and wrapping round-trips', async () => {
    const kp = await generateOrgKeypair();
    const { authKey, wrapKey } = await deriveKeys('correct horse battery', TEST_KDF);
    const wrapped = await wrapSecret(kp.privateKey, wrapKey);
    const unwrapped = await unwrapSecret(wrapped, wrapKey);
    expect(await publicKeyFromPrivate(unwrapped)).toBe(kp.publicKey);
    expect(authKey).not.toEqual(Buffer.from(wrapKey).toString('base64url'));
    const wrong = await deriveKeys('wrong password', TEST_KDF);
    await expect(unwrapSecret(wrapped, wrong.wrapKey)).rejects.toThrow();
  });
  it('token-derived keys differ by purpose', async () => {
    const a = await deriveKeyFromSecret('t', 'mcp-token');
    const b = await deriveKeyFromSecret('t', 'recovery');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
