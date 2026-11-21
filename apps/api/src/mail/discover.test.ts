import { describe, expect, it } from 'vitest';
import { candidateHosts, discover, type Hosts } from './discover.js';

describe('mail server discovery', () => {
  it('uses fixed settings for named providers', async () => {
    expect(await candidateHosts('a@icloud.com', 'icloud')).toEqual([{ imapHost: 'imap.mail.me.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false }]);
    expect((await candidateHosts('a@yahoo.com', 'yahoo'))[0]!.smtpPort).toBe(465);
  });
  it('recognises well-known domains under "other"', async () => {
    expect((await candidateHosts('someone@gmail.com', 'other'))[0]!.imapHost).toBe('imap.gmail.com');
  });
  it('guesses common host names for custom domains', async () => {
    const c = await candidateHosts('me@no-such-domain-inbox-os.test', 'other');
    expect(c.map((x) => x.imapHost)).toEqual(expect.arrayContaining(['mail.no-such-domain-inbox-os.test', 'imap.no-such-domain-inbox-os.test']));
    expect(c.length).toBeLessThanOrEqual(6);
  });
});

const host = (name: string, smtpPort = 465): Hosts => ({ imapHost: name, imapPort: 993, imapSecure: true, smtpHost: name, smtpPort, smtpSecure: smtpPort === 465 });

describe('discover', () => {
  it('skips unreachable servers and returns the first that works', async () => {
    const tried: string[] = [];
    const r = await discover('me@venture.test', 'pw', 'other', undefined, {
      candidates: async () => [host('mail.venture.test'), host('server9.host.test')],
      imap: async (h) => { tried.push(h.imapHost); return h.imapHost === 'server9.host.test' ? { ok: true } : { ok: false, error: 'Host not found' }; },
      smtp: async () => ({ ok: true }),
    });
    expect(tried).toEqual(['mail.venture.test', 'server9.host.test']);
    expect(r).toMatchObject({ ok: true, username: 'me@venture.test', hosts: { imapHost: 'server9.host.test' } });
  });

  it('stops at a wrong password instead of trying other servers', async () => {
    const tried: string[] = [];
    const r = await discover('me@venture.test', 'bad', 'other', undefined, {
      candidates: async () => [host('a.test'), host('b.test')],
      imap: async (h) => { tried.push(h.imapHost); return { ok: false, auth: true, error: 'Authentication failed: check username and password' }; },
      smtp: async () => ({ ok: true }),
    });
    expect(tried).toEqual(['a.test']);
    expect(r).toMatchObject({ ok: false, authFailed: true });
  });

  it('falls back to the other SMTP port', async () => {
    const r = await discover('me@venture.test', 'pw', 'other', undefined, {
      candidates: async () => [host('mail.venture.test', 465)],
      imap: async () => ({ ok: true }),
      smtp: async (h) => (h.smtpPort === 587 ? { ok: true } : { ok: false, error: 'Connection refused' }),
    });
    expect(r.hosts).toMatchObject({ smtpPort: 587, smtpSecure: false });
  });

  it('reports when receiving works but sending does not', async () => {
    const r = await discover('me@venture.test', 'pw', 'other', undefined, {
      candidates: async () => [host('mail.venture.test')], imap: async () => ({ ok: true }), smtp: async () => ({ ok: false, error: 'Connection refused' }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sending failed/);
  });
});
