# Security model

Inbox OS is built so that whoever runs the server (including us, the hosting provider, or someone with a database dump) **cannot read users' mail**. This document states exactly where that holds and where it can't.

## Keys

| Key | Where it lives | Protects |
|---|---|---|
| Org keypair (X25519) | Public key in the DB. The private key is **never stored unwrapped**. | All content (messages, attachments, drafts, notes, voice, agent instructions, AI key) |
| User wrap key | Derived in the browser from the password (Argon2id). Never sent. | The org private key, wrapped once per member |
| `authKey` | Derived in the browser from the same password (a separate derivation). The server stores `bcrypt(authKey)`. | Login only. It reveals nothing about the wrap key. |
| Recovery key | Shown once to the owner. Never stored. | A second wrapping of the org private key |
| MCP token | Shown once. The server stores `sha256(token)`. | A third wrapping of the org key, derived from the token itself |
| `ENCRYPTION_KEYS` | Server env (AES-256-GCM, rotatable) | IMAP passwords and OAuth tokens only |

Content is sealed with libsodium sealed boxes: a fresh symmetric key per record, sealed to the org public key. The sync worker holds only public keys. It can encrypt what it stores but cannot read any of it back.

## What the operator can see

- Account email addresses and names, organisation and workspace names, member roles
- Mailbox addresses and IMAP/SMTP host names
- Metadata: timestamps, message and unread counts, folder labels (inbox/sent/archived), sizes, which threads have drafts, the audit trail (actions, never content)
- **SHA-256 hashes** of Message-ID headers and normalised subjects (used for threading)
- Whether a thread was flagged by the prompt-injection heuristic

## What the operator cannot see

- Subjects, senders, recipients, bodies, attachments and attachment names
- Drafts, knowledge-base notes, writing voice, agent instructions
- The organisation's AI API key
- Passwords (the server never receives them)

## Unavoidable exposure (be aware)

1. **Mailbox credentials.** To sync while everyone is signed out, the worker must log in to IMAP. IMAP passwords and OAuth refresh tokens are encrypted with the deployment key (`ENCRYPTION_KEYS`), so someone with both the DB and the env can use them. Anyone holding a mailbox's credentials can read that mailbox at its provider anyway.
2. **Transit through memory.** IMAP delivers plaintext. The worker parses each message in memory, seals it, and keeps only the sealed copy. Sending works the same way in reverse: SMTP needs plaintext, so the API sees outgoing content while it sends.
3. **Unlocked agent.** Server-side drafting and auto-send require a member to unlock the org key into API memory for a chosen time. It is never written to disk, Redis or logs, and it is wiped on lock, expiry or restart.
4. **MCP.** A token's request carries the means to decrypt. During that request the API holds the org key, and the key is wiped when the request ends.
5. **AI provider.** Thread content sent to the model goes to the AI provider you configured (bring your own key), under that provider's terms.
6. **The web app is trusted code.** Whoever controls the frontend deployment could ship code that exfiltrates keys. Self-host the frontend, or pin and review its deployments.

Legal requests: we can hand over only what we hold. That is the metadata above, sealed blobs, and, if compelled, mailbox credentials (point 1).

## Other controls

- HTML email is sanitised with DOMPurify and rendered in a sandboxed iframe with no script permission and its own CSP. Remote images are blocked by default.
- Rate limits on auth, connection tests, sends, agent calls and MCP.
- Logs never include bodies, passwords or tokens (pino redaction; request logs carry method, route, status and duration only).
- Every query is scoped by organisation (and by workspace for MCP tokens). Every API and MCP input is validated with zod.
- Lost password and lost recovery key means the data is gone. That is the cost of zero access.
