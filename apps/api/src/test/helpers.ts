import { deriveKeyFromSecret, deriveKeys, generateOrgKeypair, toB64, wrapSecret, getSodium, type KdfParams } from '@inbox-os/shared';
import { encryptJson, sha256 } from '../crypto.js';
import { one, pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashAuthKey } from '../auth/sessions.js';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

// Fast KDF params for tests only.
export const TEST_KDF: KdfParams = { salt: 'AAAAAAAAAAAAAAAAAAAAAA', opsLimit: 2, memLimit: 16 * 1024 * 1024 };

export interface TestOrg {
  orgId: string; userId: string; workspaceId: string; mailboxId: string;
  publicKey: string; privateKey: Uint8Array; email: string; mailboxAddress: string;
}

let n = 0;
export async function createOrg(opts: { permission?: string; categories?: string[] } = {}): Promise<TestOrg> {
  n++;
  const kp = await generateOrgKeypair();
  const email = `owner${n}-${Date.now()}@test.local`;
  const { authKey, wrapKey } = await deriveKeys('password-123456', TEST_KDF);
  const user = await one<{ id: string }>('INSERT INTO users (email, name, auth_hash, kdf_params) VALUES ($1,$2,$3,$4) RETURNING id', [email, 'Owner', await hashAuthKey(authKey), JSON.stringify(TEST_KDF)]);
  const org = await one<{ id: string }>('INSERT INTO organisations (name, public_key, recovery_wrapped_key, recovery_proof_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`Org ${n}`, kp.publicKey, 'x', sha256('x')]);
  await pool.query(`INSERT INTO memberships (organisation_id, user_id, role, wrapped_org_key) VALUES ($1,$2,'owner',$3)`, [org!.id, user!.id, await wrapSecret(kp.privateKey, wrapKey)]);
  const ws = await one<{ id: string }>('INSERT INTO workspaces (organisation_id, name) VALUES ($1,$2) RETURNING id', [org!.id, 'WS']);
  await pool.query('INSERT INTO agent_settings (workspace_id, organisation_id, permission_level, auto_send_categories) VALUES ($1,$2,$3,$4)', [ws!.id, org!.id, opts.permission ?? 'draft', opts.categories ?? []]);
  const mailboxAddress = `me${n}@venture.test`;
  const mb = await one<{ id: string }>(
    `INSERT INTO mailboxes (organisation_id, workspace_id, provider, email_address, config_public, credentials_encrypted) VALUES ($1,$2,'imap',$3,$4,$5) RETURNING id`,
    [org!.id, ws!.id, mailboxAddress, JSON.stringify({ imapHost: 'imap.test', imapPort: 993, imapSecure: true, smtpHost: 'smtp.test', smtpPort: 465, smtpSecure: true }),
      encryptJson({ kind: 'password', username: mailboxAddress, password: 'secret' })]);
  return { orgId: org!.id, userId: user!.id, workspaceId: ws!.id, mailboxId: mb!.id, publicKey: kp.publicKey, privateKey: kp.privateKey, email, mailboxAddress };
}

/** Mint an MCP token exactly as the browser does. */
export async function createMcpToken(org: TestOrg, workspaceIds = [org.workspaceId]): Promise<string> {
  const s = await getSodium();
  const token = `iox_${await toB64(s.randombytes_buf(32))}`;
  const wrapped = await wrapSecret(org.privateKey, await deriveKeyFromSecret(token, 'mcp-token'));
  await pool.query('INSERT INTO api_tokens (organisation_id, user_id, name, token_hash, token_prefix, workspace_ids, wrapped_org_key) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [org.orgId, org.userId, 'test', sha256(token), token.slice(0, 10), workspaceIds, wrapped]);
  return token;
}

export function rawEmail(o: { from: string; to: string; subject: string; body: string; messageId: string; inReplyTo?: string; references?: string; date?: Date }): Buffer {
  const lines = [
    `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`, `Message-ID: <${o.messageId}>`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
  ];
  if (o.inReplyTo) lines.push(`In-Reply-To: <${o.inReplyTo}>`);
  if (o.references) lines.push(`References: ${o.references}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${o.body}\r\n`);
}
