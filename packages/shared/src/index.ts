import { z } from 'zod';
export * from './e2e.js';

// ---------- Enums ----------
export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSION_LEVELS = ['read_only', 'draft', 'send_with_approval', 'auto_send'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PROVIDERS = ['imap', 'outlook', 'gmail'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DRAFT_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'rejected', 'failed'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_ORIGINS = ['user', 'agent', 'mcp'] as const;
export type DraftOrigin = (typeof DRAFT_ORIGINS)[number];

export const SYNC_STATES = ['pending', 'syncing', 'idle', 'error', 'disabled'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

// ---------- Primitive schemas ----------
export const uuid = z.string().uuid();
export const emailAddress = z.string().trim().toLowerCase().email().max(320);
export const addressList = z.array(emailAddress).max(100);

// ---------- Auth (zero-access: the server only ever sees derived authKey) ----------
const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(4096);
export const kdfParamsSchema = z.object({
  salt: b64url.max(64),
  opsLimit: z.number().int().min(2).max(10),
  memLimit: z.number().int().min(16 * 1024 * 1024).max(1024 * 1024 * 1024),
});
export const preloginSchema = z.object({ email: emailAddress });
export const registerSchema = z.object({
  email: emailAddress,
  name: z.string().trim().min(1).max(120),
  organisationName: z.string().trim().min(1).max(120),
  authKey: b64url.max(64),
  kdf: kdfParamsSchema,
  orgPublicKey: b64url.max(64),
  wrappedOrgKey: b64url,
  recoveryWrappedOrgKey: b64url,
});
export const loginSchema = z.object({ email: emailAddress, authKey: b64url.max(64) });
export const inviteSchema = z.object({
  email: emailAddress,
  name: z.string().trim().min(1).max(120),
  role: z.enum(['admin', 'member']),
  authKey: b64url.max(64),
  kdf: kdfParamsSchema,
  wrappedOrgKey: b64url,
});
export const changePasswordSchema = z.object({
  currentAuthKey: b64url.max(64),
  authKey: b64url.max(64),
  kdf: kdfParamsSchema,
  /** Re-wrapped org keys for every organisation the user belongs to. */
  wrappedOrgKeys: z.array(z.object({ organisationId: z.string().uuid(), wrappedOrgKey: b64url })).max(100),
});
export const recoverSchema = z.object({
  email: emailAddress,
  /** Proof: org public key derived from recovered private key must match (checked client-side); server checks recoveryProof. */
  recoveryProof: b64url.max(128),
  authKey: b64url.max(64),
  kdf: kdfParamsSchema,
  wrappedOrgKey: b64url,
});
export const unlockSchema = z.object({
  organisationId: z.string().uuid(),
  /** Org private key, sent over TLS and held only in API memory for ttlMinutes. */
  privateKey: b64url.max(64),
  ttlMinutes: z.number().int().min(5).max(24 * 60).default(8 * 60),
});

// ---------- Workspaces ----------
const sealedField = z.string().startsWith('e1:').max(500_000);
export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});
export const workspaceUpdateSchema = workspaceCreateSchema.partial();

export const agentSettingsSchema = z.object({
  permissionLevel: z.enum(PERMISSION_LEVELS),
  autoSendCategories: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  /** Sealed SealedAgentInstructions. */
  instructionsSealed: sealedField.optional(),
  model: z.string().max(100).optional(),
});
export type AgentSettingsInput = z.infer<typeof agentSettingsSchema>;

export const voiceProfileSchema = z.object({ sealed: sealedField });
export const knowledgeItemSchema = z.object({ sealed: sealedField });

// ---------- Mailboxes ----------
export const imapConfigSchema = z.object({
  imapHost: z.string().trim().min(1).max(255),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().trim().min(1).max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
  smtpSecure: z.boolean().default(true),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(500),
});
export type ImapConfig = z.infer<typeof imapConfigSchema>;

export const mailboxCreateSchema = z.object({
  workspaceId: uuid,
  displayName: z.string().trim().max(120).optional(),
  emailAddress,
  provider: z.literal('imap'),
  config: imapConfigSchema,
});

export const mailboxUpdateSchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  workspaceId: uuid.optional(),
  config: imapConfigSchema.partial().optional(),
  enabled: z.boolean().optional(),
});

// ---------- Inbox ----------
export const threadListQuerySchema = z.object({
  workspaceId: uuid.optional(),
  mailboxId: uuid.optional(),
  label: z.string().max(100).optional(),
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const attachmentUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255),
  contentBase64: z.string().max(14_000_000), // ~10 MB decoded
});

/** Plaintext outgoing message content. Sent over TLS only at the moment of sending. */
export const outgoingSchema = z.object({
  to: addressList.min(1),
  cc: addressList.default([]),
  bcc: addressList.default([]),
  subject: z.string().max(998),
  text: z.string().max(200_000),
  html: z.string().max(500_000).nullable().optional(),
  attachments: z.array(attachmentUploadSchema).max(20).default([]),
  inReplyTo: z.string().max(998).nullable().optional(),
  references: z.array(z.string().max(998)).max(100).optional(),
});
export type OutgoingInput = z.infer<typeof outgoingSchema>;

/** Save a draft: content is sealed client-side with the org public key. */
export const draftCreateSchema = z.object({
  mailboxId: uuid,
  threadId: uuid.optional(),
  inReplyToMessageId: uuid.optional(),
  sealed: z.string().startsWith('e1:').max(2_000_000),
});
export const draftUpdateSchema = z.object({ sealed: z.string().startsWith('e1:').max(2_000_000) });

/** Send now (compose / reply / forward) or send an approved draft. */
export const sendSchema = z.object({
  mailboxId: uuid,
  threadId: uuid.optional(),
  inReplyToMessageId: uuid.optional(),
  draftId: uuid.optional(),
  message: outgoingSchema,
});

export const voiceDraftSchema = z.object({
  threadId: uuid,
  instruction: z.string().trim().min(1).max(4000),
  /** Optional org private key for this single request (hosts that cannot hold an unlocked key). */
  privateKey: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64).optional(),
});

/** The AI key is sealed client-side; the server can only use it while the org is unlocked. */
export const aiKeySchema = z.object({ provider: z.literal('anthropic'), sealed: sealedField, hint: z.string().max(12) });

/** The browser generates the token, sends only its hash plus the org key wrapped by a token-derived key. */
export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  workspaceIds: z.array(uuid).min(1).max(100),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenPrefix: z.string().max(16),
  wrappedOrgKey: b64url,
});

/** Permission rank: higher means more capability. */
export function permissionRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}
