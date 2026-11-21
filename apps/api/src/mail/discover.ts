import dns from 'node:dns/promises';
import type { ImapConfig } from '@inbox-os/shared';
import { friendlyError, imapClient, smtpTransport } from './transport.js';

export type QuickProvider = 'icloud' | 'google' | 'microsoft' | 'yahoo' | 'aol' | 'other';
export type Hosts = Omit<ImapConfig, 'username' | 'password'>;

const h = (imapHost: string, smtpHost: string, smtpPort = 465): Hosts => ({ imapHost, imapPort: 993, imapSecure: true, smtpHost, smtpPort, smtpSecure: smtpPort === 465 });

export const PROVIDER_HOSTS: Record<Exclude<QuickProvider, 'other'>, Hosts> = {
  icloud: h('imap.mail.me.com', 'smtp.mail.me.com', 587),
  google: h('imap.gmail.com', 'smtp.gmail.com'),
  microsoft: h('outlook.office365.com', 'smtp.office365.com', 587),
  yahoo: h('imap.mail.yahoo.com', 'smtp.mail.yahoo.com'),
  aol: h('imap.aol.com', 'smtp.aol.com'),
};

const DOMAIN_PROVIDERS: Record<string, Exclude<QuickProvider, 'other'>> = {
  'gmail.com': 'google', 'googlemail.com': 'google', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'aol.com': 'aol', 'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'live.com': 'microsoft', 'msn.com': 'microsoft',
};

/** Mozilla's public mail-settings database (the one Thunderbird uses). Only the domain is sent. */
async function ispdb(domain: string): Promise<Hosts | null> {
  try {
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const xml = await res.text();
    const block = (type: string) => xml.match(new RegExp(`<(?:incoming|outgoing)Server type="${type}">([\\s\\S]*?)</(?:incoming|outgoing)Server>`))?.[1];
    const field = (b: string | undefined, f: string) => b?.match(new RegExp(`<${f}>([^<]+)</${f}>`))?.[1];
    const imap = block('imap');
    const smtp = block('smtp');
    const imapHost = field(imap, 'hostname');
    const smtpHost = field(smtp, 'hostname');
    if (!imapHost || !smtpHost || /%/.test(imapHost + smtpHost)) return null;
    const smtpPort = Number(field(smtp, 'port') ?? 465);
    return { imapHost, imapPort: Number(field(imap, 'port') ?? 993), imapSecure: field(imap, 'socketType') !== 'STARTTLS', smtpHost, smtpPort, smtpSecure: field(smtp, 'socketType') === 'SSL' };
  } catch {
    return null;
  }
}

/** Ordered guesses for a domain: known providers, public database, MX-based hints, then common host names. */
export async function candidateHosts(email: string, provider: QuickProvider): Promise<Hosts[]> {
  if (provider !== 'other') return [PROVIDER_HOSTS[provider]];
  const domain = email.split('@')[1]!.toLowerCase();
  const known = DOMAIN_PROVIDERS[domain];
  if (known) return [PROVIDER_HOSTS[known]];
  const out: Hosts[] = [];
  const [db, mx] = await Promise.all([ispdb(domain), dns.resolveMx(domain).catch(() => [])]);
  if (db) out.push(db);
  const mxHosts = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
  if (mxHosts.some((m) => /google(mail)?\.com$/.test(m))) out.push(PROVIDER_HOSTS.google);
  if (mxHosts.some((m) => /outlook\.com$/.test(m))) out.push(PROVIDER_HOSTS.microsoft);
  out.push(h(`mail.${domain}`, `mail.${domain}`), h(`imap.${domain}`, `smtp.${domain}`));
  // Shared hosting (cPanel / DirectAdmin): the MX host is usually the mail server and matches its TLS certificate.
  for (const m of mxHosts.slice(0, 2)) if (!/google|outlook|protection|mimecast|proofpoint/.test(m)) out.push(h(m, m));
  out.push(h(domain, domain));
  const seen = new Set<string>();
  return out.filter((c) => { const k = `${c.imapHost}|${c.smtpHost}|${c.smtpPort}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
}

export interface DiscoverResult { ok: boolean; hosts?: Hosts; username?: string; error?: string; authFailed?: boolean }

async function tryImap(hosts: Hosts, username: string, password: string): Promise<{ ok: boolean; auth?: boolean; error?: string }> {
  const client = imapClient(hosts, { kind: 'password', username, password }, { quick: true });
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    const msg = friendlyError(err);
    return { ok: false, auth: /Authentication failed/.test(msg), error: msg };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function trySmtp(hosts: Hosts, username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await smtpTransport(hosts, { kind: 'password', username, password }).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

export interface DiscoverDeps {
  candidates?: (email: string, provider: QuickProvider) => Promise<Hosts[]>;
  imap?: typeof tryImap;
  smtp?: typeof trySmtp;
}

/** Find working IMAP + SMTP settings for an address, trying candidates in order within a time budget. */
export async function discover(email: string, password: string, provider: QuickProvider, usernameOverride?: string, deps: DiscoverDeps = {}): Promise<DiscoverResult> {
  const deadline = Date.now() + 40_000;
  const imap = deps.imap ?? tryImap;
  const smtp = deps.smtp ?? trySmtp;
  const candidates = await (deps.candidates ?? candidateHosts)(email, provider);
  const usernames = usernameOverride ? [usernameOverride] : [email];
  let lastError = 'Could not find a mail server for this address.';
  let authFailed = false;
  for (const hosts of candidates) {
    for (const username of usernames) {
      if (Date.now() > deadline) break;
      const r = await imap(hosts, username, password);
      if (!r.ok) {
        if (r.auth) { authFailed = true; lastError = r.error!; }
        else if (!authFailed) lastError = r.error ?? lastError;
        continue;
      }
      // IMAP works. Find an SMTP port that accepts the same login.
      const smtpOptions: Hosts[] = [hosts, { ...hosts, smtpPort: hosts.smtpPort === 465 ? 587 : 465, smtpSecure: hosts.smtpPort !== 465 }];
      for (const option of smtpOptions) {
        const sent = await smtp(option, username, password);
        if (sent.ok) return { ok: true, hosts: option, username };
        lastError = `Incoming mail works, but sending failed: ${sent.error}`;
      }
      return { ok: false, error: lastError };
    }
    if (authFailed) break; // right server, wrong password: don't hammer other hosts
  }
  return { ok: false, error: lastError, authFailed };
}
