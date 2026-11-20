import type { ImapConfig } from '@inbox-os/shared';
import { decryptJson, encryptJson } from '../crypto.js';
import { one, query } from '../db/pool.js';
import { notFound } from '../errors.js';
import { refreshOAuthToken } from '../providers/oauth.js';

/**
 * Mailbox credentials are the one secret the server must be able to use unattended
 * (to keep syncing while every user is signed out). They are AES-256-GCM encrypted with
 * the deployment key from ENCRYPTION_KEYS, never returned by the API, and never logged.
 */
export type MailboxCredentials =
  | { kind: 'password'; username: string; password: string }
  | { kind: 'oauth'; username: string; accessToken: string; refreshToken: string; expiresAt: number };

export interface MailboxRow {
  id: string;
  organisation_id: string;
  workspace_id: string;
  provider: 'imap' | 'outlook' | 'gmail';
  email_address: string;
  display_name: string | null;
  config_public: Pick<ImapConfig, 'imapHost' | 'imapPort' | 'imapSecure' | 'smtpHost' | 'smtpPort' | 'smtpSecure'>;
  credentials_encrypted: string;
  enabled: boolean;
}

export async function loadMailbox(id: string): Promise<MailboxRow> {
  const row = await one<MailboxRow>('SELECT * FROM mailboxes WHERE id = $1', [id]);
  if (!row) throw notFound('Mailbox');
  return row;
}

export const encryptCredentials = (c: MailboxCredentials) => encryptJson(c);

/** Returns usable credentials, refreshing OAuth access tokens when near expiry. */
export async function getCredentials(mb: MailboxRow): Promise<MailboxCredentials> {
  const creds = decryptJson<MailboxCredentials>(mb.credentials_encrypted);
  if (creds.kind === 'oauth' && creds.expiresAt < Date.now() + 120_000) {
    const fresh = await refreshOAuthToken(mb.provider as 'outlook' | 'gmail', creds.refreshToken);
    const next: MailboxCredentials = { ...creds, ...fresh };
    await query('UPDATE mailboxes SET credentials_encrypted = $2 WHERE id = $1', [mb.id, encryptCredentials(next)]);
    return next;
  }
  return creds;
}

export const OAUTH_HOSTS = {
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
} as const;
