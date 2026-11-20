import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import crypto from 'node:crypto';
import type { OutgoingInput } from '@inbox-os/shared';
import { getCredentials, loadMailbox, type MailboxRow } from '../mail/credentials.js';
import { ingestMessage, type IngestResult } from '../mail/ingest.js';
import { hashId, normalizeMessageId } from '../mail/threading.js';
import { hostsFor, imapClient, smtpTransport } from '../mail/transport.js';
import { planFolders } from '../mail/sync.js';
import { OrgCrypto, orgPublicKey } from '../keyvault.js';
import { logger } from '../logger.js';
import { HttpError } from '../errors.js';

export async function buildRaw(mb: Pick<MailboxRow, 'email_address' | 'display_name'>, msg: OutgoingInput): Promise<{ raw: Buffer; messageId: string }> {
  const domain = mb.email_address.split('@')[1] ?? 'localhost';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const refs = [...(msg.references ?? [])];
  if (msg.inReplyTo && !refs.includes(msg.inReplyTo)) refs.push(msg.inReplyTo);
  const composer = new MailComposer({
    from: mb.display_name ? { name: mb.display_name, address: mb.email_address } : mb.email_address,
    to: msg.to,
    cc: msg.cc,
    // Bcc is deliberately not put in headers; it is only in the SMTP envelope.
    subject: msg.subject,
    text: msg.text,
    html: msg.html ?? undefined,
    messageId,
    inReplyTo: msg.inReplyTo ?? undefined,
    references: refs.length ? refs : undefined,
    date: new Date(),
    attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') })),
  });
  const raw: Buffer = await new Promise((resolve, reject) => composer.compile().build((err, out) => (err ? reject(err) : resolve(out))));
  return { raw, messageId };
}

export interface SendOutcome { messageIdHash: string; ingest: IngestResult | null }

/**
 * Send via the mailbox's own SMTP server (send-as the correct mailbox), save a copy to Sent
 * when the provider doesn't do so automatically, then store our sealed copy.
 */
export async function sendViaMailbox(mailboxId: string, msg: OutgoingInput, opts: { transport?: ReturnType<typeof smtpTransport> } = {}): Promise<SendOutcome> {
  const mb = await loadMailbox(mailboxId);
  if (!mb.enabled) throw new HttpError(409, 'Mailbox is disabled', 'mailbox_disabled');
  const { raw, messageId } = await buildRaw(mb, msg);
  const creds = await getCredentials(mb);
  const transport = opts.transport ?? smtpTransport(hostsFor(mb), creds);
  const envelope = { from: mb.email_address, to: [...msg.to, ...msg.cc, ...msg.bcc] };
  await transport.sendMail({ envelope, raw });

  // Gmail and Outlook save sent mail server-side; generic IMAP hosts usually don't.
  if (mb.provider === 'imap' && !opts.transport) {
    const client = imapClient(hostsFor(mb), creds);
    try {
      await client.connect();
      const sent = planFolders(await client.list()).find((p) => p.label === 'sent');
      if (sent) await client.append(sent.path, raw, ['\\Seen']);
    } catch (err) {
      logger.warn({ mailboxId, code: (err as { code?: string }).code }, 'could not append to Sent folder');
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  let ingest: IngestResult | null = null;
  try {
    const parsed = await simpleParser(raw);
    const crypto = new OrgCrypto(mb.organisation_id, await orgPublicKey(mb.organisation_id), null);
    ingest = await ingestMessage(
      { id: mb.id, organisationId: mb.organisation_id, workspaceId: mb.workspace_id, emailAddress: mb.email_address },
      { parsed, folder: '__sent_local', label: 'sent', isRead: true },
      crypto,
    );
  } catch (err) {
    logger.warn({ mailboxId }, 'stored-copy ingest failed after send');
  }
  return { messageIdHash: hashId(normalizeMessageId(messageId)!), ingest };
}
