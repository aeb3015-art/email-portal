import { permissionRank, type DraftOrigin, type PermissionLevel } from '@inbox-os/shared';

export interface AgentSettingsRow {
  permission_level: PermissionLevel;
  auto_send_categories: string[];
}

export type SendDecision =
  | { action: 'send' }
  | { action: 'pending_approval'; reason: string }
  | { action: 'deny'; reason: string };

export function canRead(level: PermissionLevel): boolean {
  return permissionRank(level) >= permissionRank('read_only');
}

export function canDraft(level: PermissionLevel): boolean {
  return permissionRank(level) >= permissionRank('draft');
}

export interface SendRequest {
  origin: DraftOrigin;
  settings: AgentSettingsRow;
  category?: string | null;
  /** Thread content looked like it tried to instruct the agent. */
  injectionFlagged: boolean;
  /** Recipients of the outgoing message. */
  recipients: string[];
  /** Addresses that legitimately took part in the thread (from stored messages, never from model output). */
  threadParticipants: string[];
  isReply: boolean;
}

/**
 * The single permission gate for any non-human send. Inputs come from the database and
 * workspace settings, never from email text or model output, so email content cannot
 * raise permissions, add recipients or unlock tools.
 */
export function decideSend(r: SendRequest): SendDecision {
  if (r.origin === 'user') return { action: 'send' };
  const level = r.settings.permission_level;
  if (level === 'read_only') return { action: 'deny', reason: 'Agent is read-only in this workspace' };
  if (level === 'draft') return { action: 'deny', reason: 'Agent may only draft in this workspace; a person must send' };
  if (level === 'send_with_approval') return { action: 'pending_approval', reason: 'Workspace requires approval for agent sends' };

  // auto_send: every condition must hold, otherwise fall back to approval (never to deny-and-drop)
  const cats = r.settings.auto_send_categories.map((c) => c.toLowerCase());
  if (!r.category || !cats.includes(r.category.toLowerCase())) {
    return { action: 'pending_approval', reason: `Category "${r.category ?? 'none'}" is not enabled for auto-send` };
  }
  if (r.injectionFlagged) return { action: 'pending_approval', reason: 'Thread content appears to instruct the agent (possible prompt injection)' };
  if (!r.isReply) return { action: 'pending_approval', reason: 'Auto-send is limited to replies on existing threads' };
  const allowed = new Set(r.threadParticipants.map((a) => a.toLowerCase()));
  const outsiders = r.recipients.filter((a) => !allowed.has(a.toLowerCase()));
  if (outsiders.length) return { action: 'pending_approval', reason: 'Recipients include addresses not already in the thread' };
  return { action: 'send' };
}
