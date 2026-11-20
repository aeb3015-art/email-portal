import type { Job } from 'bullmq';
import { audit } from '../audit.js';
import { orgCrypto } from '../keyvault.js';
import { logger } from '../logger.js';
import { getAgentSettings } from '../services/drafts.js';
import { one } from '../db/pool.js';
import type { AgentJob } from '../queue/index.js';
import { canDraft } from './permissions.js';
import { draftReply } from './drafter.js';

/**
 * Runs in the API process (the only place an unlocked key can exist). If the organisation is
 * locked, the agent simply doesn't act: no key ever leaves the browser without a person.
 */
export async function handleNewMail(job: Job<AgentJob>): Promise<void> {
  const { organisationId, workspaceId, threadId } = job.data;
  const settings = await getAgentSettings(workspaceId);
  if (!canDraft(settings.permission_level)) return;
  const hasKey = await one('SELECT 1 FROM ai_keys WHERE organisation_id = $1', [organisationId]);
  if (!hasKey) return;
  const crypto = await orgCrypto(organisationId);
  if (!crypto.canDecrypt) {
    await audit(organisationId, { type: 'system' }, 'agent.skipped_locked', { workspaceId, targetType: 'thread', targetId: threadId });
    return;
  }
  // Don't pile drafts onto a thread that already has one waiting.
  const open = await one(`SELECT 1 FROM drafts WHERE thread_id = $1 AND status IN ('draft','pending_approval') AND origin = 'agent'`, [threadId]);
  if (open) return;
  try {
    await draftReply({ orgId: organisationId, threadId, crypto, actor: { type: 'agent' }, origin: 'agent', attemptAutoSend: true });
  } catch (err) {
    logger.warn({ threadId, code: (err as { code?: string }).code }, 'agent draft failed');
    throw err;
  }
}
