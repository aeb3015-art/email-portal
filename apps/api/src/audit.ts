import { query, type Db } from './db/pool.js';

export type ActorType = 'user' | 'agent' | 'mcp' | 'system';
export interface Actor { type: ActorType; userId?: string | null; tokenId?: string | null }

/** Audit metadata must never contain message content, credentials or tokens. */
export async function audit(
  orgId: string,
  actor: Actor,
  action: string,
  opts: { workspaceId?: string | null; targetType?: string; targetId?: string | null; metadata?: Record<string, unknown> } = {},
  db?: Db,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (organisation_id, workspace_id, actor_type, actor_user_id, actor_token_id, action, target_type, target_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgId, opts.workspaceId ?? null, actor.type, actor.userId ?? null, actor.tokenId ?? null, action, opts.targetType ?? null, opts.targetId ?? null, JSON.stringify(opts.metadata ?? {})],
    db,
  );
}
