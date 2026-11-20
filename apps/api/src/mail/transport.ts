import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import nodemailer from 'nodemailer';
import type { ImapConfig } from '@inbox-os/shared';
import { logger } from '../logger.js';
import { getCredentials, type MailboxCredentials, type MailboxRow, OAUTH_HOSTS } from './credentials.js';

type Hosts = Omit<ImapConfig, 'username' | 'password'>;

function authFor(creds: MailboxCredentials) {
  return creds.kind === 'password'
    ? { user: creds.username, pass: creds.password }
    : { user: creds.username, accessToken: creds.accessToken };
}

export function hostsFor(mb: Pick<MailboxRow, 'provider' | 'config_public'>): Hosts {
  return mb.provider === 'imap' ? (mb.config_public as Hosts) : OAUTH_HOSTS[mb.provider];
}

export function imapClient(hosts: Hosts, creds: MailboxCredentials): ImapFlow {
  const opts: ImapFlowOptions = {
    host: hosts.imapHost,
    port: hosts.imapPort,
    secure: hosts.imapSecure,
    auth: authFor(creds) as ImapFlowOptions['auth'],
    logger: false,
    emitLogs: false,
    socketTimeout: 5 * 60_000,
    tls: { minVersion: 'TLSv1.2' },
  };
  return new ImapFlow(opts);
}

export function smtpTransport(hosts: Hosts, creds: MailboxCredentials) {
  return nodemailer.createTransport({
    host: hosts.smtpHost,
    port: hosts.smtpPort,
    secure: hosts.smtpSecure,
    requireTLS: !hosts.smtpSecure,
    auth: creds.kind === 'password'
      ? { user: creds.username, pass: creds.password }
      : { type: 'OAuth2', user: creds.username, accessToken: creds.accessToken },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 20_000,
    logger: false,
  });
}

export interface ConnectionTestResult {
  imap: { ok: boolean; error?: string; folders?: number };
  smtp: { ok: boolean; error?: string };
}

/** Verify IMAP login + folder listing and SMTP auth, without storing anything. */
export async function testConnection(hosts: Hosts, creds: MailboxCredentials): Promise<ConnectionTestResult> {
  const result: ConnectionTestResult = { imap: { ok: false }, smtp: { ok: false } };
  const client = imapClient(hosts, creds);
  try {
    await client.connect();
    const list = await client.list();
    result.imap = { ok: true, folders: list.length };
  } catch (err) {
    result.imap = { ok: false, error: friendlyError(err) };
  } finally {
    await client.logout().catch(() => undefined);
  }
  try {
    await smtpTransport(hosts, creds).verify();
    result.smtp = { ok: true };
  } catch (err) {
    result.smtp = { ok: false, error: friendlyError(err) };
  }
  return result;
}

export function friendlyError(err: unknown): string {
  const e = err as { code?: string; responseText?: string; message?: string; authenticationFailed?: boolean };
  if (e.authenticationFailed || /auth/i.test(e.responseText ?? '') || e.code === 'EAUTH') return 'Authentication failed: check username and password (Yahoo/Gmail need an app password).';
  if (e.code === 'ENOTFOUND') return 'Host not found: check the server name.';
  if (e.code === 'ECONNREFUSED') return 'Connection refused: check the port and SSL setting.';
  if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET') return 'Connection timed out: check host, port and SSL setting.';
  if (/certificate|self.signed|CERT/i.test(e.message ?? '')) return 'TLS certificate error: the server certificate is not valid for this host name.';
  logger.debug({ code: e.code }, 'connection test error');
  return (e.responseText ?? e.message ?? 'Unknown error').slice(0, 200);
}

export async function mailboxSmtp(mb: MailboxRow) {
  return smtpTransport(hostsFor(mb), await getCredentials(mb));
}
