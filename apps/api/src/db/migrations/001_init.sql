CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- X25519 public key. The private key never exists server-side at rest.
  public_key TEXT NOT NULL,
  -- Org private key wrapped by the recovery key (shown once to the owner).
  recovery_wrapped_key TEXT NOT NULL,
  -- sha256 of a recovery-key-derived proof, so a recovery attempt can be verified.
  recovery_proof_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- bcrypt(authKey). authKey is derived client-side from the password with Argon2id;
  -- the server never receives the password itself.
  auth_hash TEXT NOT NULL,
  kdf_params JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  -- Org private key wrapped by this user's password-derived wrap key.
  wrapped_org_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_org_idx ON workspaces(organisation_id);

-- Encrypted blobs are stored as "v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>"
CREATE TABLE mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('imap','outlook','gmail')),
  email_address TEXT NOT NULL,
  display_name TEXT,
  config_public JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_encrypted TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sync_state TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, email_address)
);
CREATE INDEX mailboxes_ws_idx ON mailboxes(workspace_id);

-- Per-folder sync cursor (UIDVALIDITY / last UID for IMAP; delta link for Graph)
CREATE TABLE mailbox_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  special_use TEXT,
  uid_validity BIGINT,
  last_uid BIGINT NOT NULL DEFAULT 0,
  delta_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, path)
);

CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  -- Sealed SealedThreadSummary (subject, snippet, participants).
  summary_sealed TEXT NOT NULL,
  -- sha256 of normalized subject, used only as a threading fallback.
  subject_hash TEXT NOT NULL DEFAULT '',
  labels TEXT[] NOT NULL DEFAULT '{}',
  message_count INT NOT NULL DEFAULT 0,
  unread_count INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  injection_flagged BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX threads_list_idx ON threads(organisation_id, last_message_at DESC);
CREATE INDEX threads_ws_idx ON threads(workspace_id, last_message_at DESC);
CREATE INDEX threads_mb_idx ON threads(mailbox_id, last_message_at DESC);
CREATE INDEX threads_labels_idx ON threads USING GIN(labels);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uid BIGINT,
  provider_message_id TEXT,
  -- Threading headers are stored as sha256 hashes, never in clear.
  message_id_hash TEXT,
  in_reply_to_hash TEXT,
  references_hashes TEXT[] NOT NULL DEFAULT '{}',
  -- Sealed SealedMessage: subject, addresses, bodies, attachment list.
  content_sealed TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_outbound BOOLEAN NOT NULL DEFAULT false,
  flags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_uid_uniq ON messages(mailbox_id, folder, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX messages_provider_uniq ON messages(mailbox_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_msgid_idx ON messages(mailbox_id, message_id_hash);
CREATE INDEX messages_thread_idx ON messages(thread_id, sent_at);

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  draft_id UUID,
  -- Sealed metadata {filename, contentType} and sealed bytes.
  meta_sealed TEXT NOT NULL,
  size_bytes INT NOT NULL,
  content_sealed TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_msg_idx ON attachments(message_id);

CREATE TABLE drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  in_reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','sent','rejected','failed')),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','agent','mcp')),
  category TEXT,
  -- Sealed SealedDraft (recipients, subject, bodies).
  content_sealed TEXT NOT NULL,
  approval_reason TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_token_id UUID,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  sent_message_id_hash TEXT,
  send_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drafts_status_idx ON drafts(organisation_id, status);
CREATE INDEX drafts_ws_idx ON drafts(workspace_id, status);
ALTER TABLE attachments ADD CONSTRAINT attachments_draft_fk FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE;

CREATE TABLE agent_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  permission_level TEXT NOT NULL DEFAULT 'draft' CHECK (permission_level IN ('read_only','draft','send_with_approval','auto_send')),
  auto_send_categories TEXT[] NOT NULL DEFAULT '{}',
  instructions_sealed TEXT,
  model TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE voice_profiles (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  profile_sealed TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_sealed TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_ws_idx ON knowledge_items(workspace_id);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent','mcp','system')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_token_id UUID,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_log(organisation_id, created_at DESC);

CREATE TABLE api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  workspace_ids UUID[] NOT NULL,
  -- Org private key wrapped by a key derived from the token secret; only the token can open it.
  wrapped_org_key TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_keys (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  -- Sealed with the org public key: usable only while the org is unlocked.
  key_sealed TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, provider)
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  code_verifier_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
