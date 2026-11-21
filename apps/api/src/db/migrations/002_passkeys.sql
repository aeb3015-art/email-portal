-- Passkeys (WebAuthn). A passkey both signs the user in and, through the WebAuthn PRF
-- extension, yields a secret in the browser that unwraps the organisation key. The server
-- stores only the public key and the org key wrapped by that browser-side secret.
CREATE TABLE passkeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}',
  name TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

CREATE TABLE passkey_org_keys (
  passkey_id UUID NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  wrapped_org_key TEXT NOT NULL,
  PRIMARY KEY (passkey_id, organisation_id)
);

CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('register','login')),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Passkey-only accounts have no usable password.
ALTER TABLE users ADD COLUMN has_password BOOLEAN NOT NULL DEFAULT true;
