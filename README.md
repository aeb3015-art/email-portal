# Inbox OS

A self-hosted, AI-agent-first unified inbox for people who run several ventures across many domains. Every mailbox from every provider lands in one place. Each project workspace has its own agent that reads, drafts and, with permission, sends.

**Zero-access by design.** Mail content, drafts, notes, writing-voice profiles, agent instructions and the AI API key are encrypted with keys that only your browser (or a credential you explicitly create) can open. The database holds sealed envelopes and hashes. See [SECURITY.md](SECURITY.md) for exactly what the operator can and cannot see.

```
apps/api         Node + TypeScript API, IMAP sync worker, MCP endpoint (Railway)
apps/web         Next.js frontend: decrypts in the browser (Vercel)
packages/shared  zod schemas + encryption primitives shared by both
```

## Features (v1)

- Email + password auth (the password never leaves the browser), organisations, roles (owner / admin / member), account recovery key
- Project workspaces, each with mailboxes, a writing voice, a knowledge base and agent settings
- Mailboxes: generic IMAP/SMTP (Assura, cPanel/DirectAdmin hosts, Yahoo, Gmail and Outlook app passwords) with a connection test; Outlook / Microsoft 365 and Gmail via OAuth (XOAUTH2)
- Sync engine: 30-day backfill, IMAP IDLE for real-time mail, UID/UIDVALIDITY cursors, reconnect with jittered backoff, threading by Message-ID / References / In-Reply-To
- Unified inbox: filters by workspace, mailbox and label, local search, thread view, compose, reply, reply-all, forward, attachments, send-as the right mailbox
- Agent permission levels per workspace: `read_only` → `draft` → `send_with_approval` → `auto_send` (only for categories you name), an approval queue and a full audit log
- Voice to draft: browser speech recognition, with a server transcription fallback
- Built-in MCP server at `/mcp` (Streamable HTTP, bearer token per user and set of workspaces)
- Bring-your-own AI key (Anthropic first, behind a provider interface)

## Local setup

Requirements: Node 20+, Postgres 14+, Redis 6+.

```bash
npm install
```

```bash
cp .env.example apps/api/.env
```

Generate an encryption key and paste it into `ENCRYPTION_KEYS` in `apps/api/.env`:

```bash
echo "k1:$(openssl rand -base64 32)"
```

```bash
npm run build -w @inbox-os/shared
```

```bash
npm run migrate
```

```bash
npm run seed
```

The seed creates `demo@inbox-os.local` / `demo-password-123` and prints a recovery key. Then run each of these in its own terminal:

```bash
npm run dev:api
```

```bash
WORKER_HEALTH_PORT=4001 npm run dev:worker
```

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev:web
```

Open http://localhost:3000. To run the tests (they need Postgres; set `TEST_DATABASE_URL` or create `inbox_test` owned by `inbox:inbox`):

```bash
npm test
```

## Deploy

### Railway (API + worker + Postgres + Redis)

1. Create a Railway project and add the **PostgreSQL** and **Redis** plugins.
2. Add a service **api** from this GitHub repo. It uses `railway.json` and the root `Dockerfile`, with `/health` as the health check.
3. Add a second service **worker** from the same repo. In its settings, set the config file path to `railway.worker.json` (start command `node dist/worker.js`, 1 replica).
4. Set these variables on **both** services:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `REDIS_URL=${{Redis.REDIS_URL}}`
   - `ENCRYPTION_KEYS`: the same value on both (generate as shown above)
   - `WEB_ORIGIN=https://your-app.vercel.app`
   - `PUBLIC_API_URL=https://your-api.up.railway.app`
   - Optional: `MICROSOFT_*`, `GOOGLE_*`, `TRANSCRIPTION_*`
5. Generate a public domain for **api** only. Migrations run automatically when either service starts.

Run **one API replica**. Unlocked agent keys live in that process's memory (by design they are never stored anywhere shared). If you scale out, MCP keeps working on every replica; only the unlocked server-side agent is per-replica.

### Vercel (web)

1. Import the repo into Vercel and set **Root Directory** to `apps/web`. `apps/web/vercel.json` installs and builds from the monorepo root.
2. Set `NEXT_PUBLIC_API_URL=https://your-api.up.railway.app`.
3. Deploy, then put the Vercel URL into `WEB_ORIGIN` on Railway (comma-separate several origins if needed).

### Key rotation

Prepend a new key, for example `ENCRYPTION_KEYS=k2:NEW,k1:OLD`. New credentials use `k2` and old ones still decrypt. This key protects only mailbox credentials; mail content uses per-organisation keys that the server does not hold.

## Adding a mailbox

**Settings → Mailboxes → Add account.** Pick your provider (iCloud, Microsoft Outlook, Google, Yahoo, AOL or Other), then enter only your email and password. Inbox OS finds the server settings itself. For a custom domain choose **Other**; if the server cannot be found automatically, the manual fields below appear:

### IMAP + SMTP (example: Assura or another cPanel / DirectAdmin host)

| Field | Value |
|---|---|
| Email address | `you@yourdomain.com` |
| IMAP host | `mail.yourdomain.com` (or the server name in your hosting panel) |
| IMAP port | `993`, SSL/TLS on |
| SMTP host | `mail.yourdomain.com` |
| SMTP port | `465`, SSL/TLS on (or `587` with SSL/TLS **off**, which uses STARTTLS) |
| Username | the full email address |
| Password | the mailbox password |

Click **Test connection**. Both IMAP and SMTP should show OK. Then click **Connect mailbox**. If the host's certificate is issued for the server's own name (for example `server123.assurahosting.com`) rather than your domain, use that name as the host.

- **Yahoo:** `imap.mail.yahoo.com:993` / `smtp.mail.yahoo.com:465`, with an *app password* (Yahoo account → Security → Generate app password).
- **Gmail without OAuth:** turn on 2-step verification, create an app password, and use `imap.gmail.com:993` / `smtp.gmail.com:465`.

### Outlook / Microsoft 365 (OAuth)

Register an app in Microsoft Entra ID:

- Redirect URI (Web): `https://your-api/oauth/outlook/callback`
- Delegated permissions: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`, `email`

Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. Tenants must allow SMTP AUTH for the mailbox.

### Gmail (OAuth)

Create an OAuth client in Google Cloud with redirect `https://your-api/oauth/gmail/callback` and the scope `https://mail.google.com/`. This is a **restricted scope**: until you pass Google's paid CASA security assessment, keep the app in *Testing* mode with named test users, or use IMAP with an app password.

## Using the MCP endpoint in Claude

1. In Inbox OS: **Settings → MCP → Create token**. Pick the workspaces the token may reach and copy the `iox_…` token. It is shown once.
2. In Claude: **Settings → Connectors → Add custom connector**.
   - URL: `https://your-api.up.railway.app/mcp`
   - Authentication: bearer token / API key → paste the `iox_…` token
3. Available tools: `list_mailboxes`, `list_threads`, `get_thread`, `search_messages`, `create_draft`, `update_draft`, `send_draft`, `list_pending_approvals`.

`send_draft` follows the workspace permission level. It sends, returns `pending_approval` (the draft appears in the web app's approval queue), or is denied. A token works only while it isn't revoked and its user is still a member of the organisation.

## Agent and permission model

| Level | Agent can |
|---|---|
| `read_only` | Read only. It cannot draft or send. |
| `draft` | Create drafts. A person must send. |
| `send_with_approval` | Request sends. Every send goes to the approval queue. |
| `auto_send` | Send on its own only if **all** of these hold: the category is in the workspace's list; it is a reply on an existing thread; every recipient already took part in the thread; and the thread wasn't flagged for prompt injection. Anything else goes to approval. |

Email text is treated as untrusted data. It is fenced in the prompt, and reply recipients are taken from stored headers, never from model output. Email text cannot change permissions, recipients or tools. Every agent and MCP action is written to the audit log (without message content).

When new mail arrives, the agent drafts automatically only while a member has **unlocked** it (Settings → Agent). Unlocking lends the organisation key to the API process memory for a chosen time (1–24 h).

## Roadmap (not in v1)

- Kelvar WhatsApp threads in the same thread view, plus a separate Kelvar MCP server (`send_message`, `send_template`, `list_chats`, `get_messages`, `search_contacts`, `get_message_status`). Open question: does Kelvar use the WhatsApp Business Cloud API or a WhatsApp Web session?
- Email-to-actions (tasks, deadlines, invoices, leads → CRM and calendar), follow-up autopilot, spoken morning briefing, agent-owned addresses
- White-label / self-hosted licence and per-seat billing
- Encrypted search index (client-built) to replace the in-memory scan of recent messages
