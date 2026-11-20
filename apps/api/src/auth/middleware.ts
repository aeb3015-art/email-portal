import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@inbox-os/shared';
import { one, query } from '../db/pool.js';
import { forbidden, HttpError, notFound } from '../errors.js';
import { resolveSession } from './sessions.js';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
  sessionToken: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: AuthContext }
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Requires a valid session and an X-Org-Id the user is a member of. */
export function requireAuth(opts: { org?: boolean } = { org: true }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearer(req);
      if (!token || !token.startsWith('ses_')) throw new HttpError(401, 'Authentication required', 'unauthorized');
      const session = await resolveSession(token);
      if (!session) throw new HttpError(401, 'Session expired', 'unauthorized');
      if (opts.org === false) {
        req.auth = { userId: session.userId, orgId: '', role: 'member', sessionToken: token };
        return next();
      }
      const orgId = String(req.headers['x-org-id'] ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new HttpError(400, 'X-Org-Id header required', 'bad_request');
      const m = await one<{ role: Role }>('SELECT role FROM memberships WHERE user_id = $1 AND organisation_id = $2', [session.userId, orgId]);
      if (!m) throw forbidden('Not a member of this organisation');
      req.auth = { userId: session.userId, orgId, role: m.role, sessionToken: token };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return next(forbidden('Insufficient role'));
    next();
  };
}

/** Tenant isolation: every workspace lookup is scoped by organisation. */
export async function assertWorkspace(orgId: string, workspaceId: string): Promise<void> {
  const row = await one('SELECT 1 FROM workspaces WHERE id = $1 AND organisation_id = $2', [workspaceId, orgId]);
  if (!row) throw notFound('Workspace');
}

export async function assertMailbox(orgId: string, mailboxId: string, workspaceIds?: string[]) {
  const row = await one<{ id: string; workspace_id: string; email_address: string; provider: string }>(
    'SELECT id, workspace_id, email_address, provider FROM mailboxes WHERE id = $1 AND organisation_id = $2',
    [mailboxId, orgId],
  );
  if (!row || (workspaceIds && !workspaceIds.includes(row.workspace_id))) throw notFound('Mailbox');
  return row;
}

export async function workspaceIdsForOrg(orgId: string): Promise<string[]> {
  return (await query<{ id: string }>('SELECT id FROM workspaces WHERE organisation_id = $1', [orgId])).rows.map((r) => r.id);
}
