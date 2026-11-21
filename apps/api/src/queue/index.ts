import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const MAILBOX_CHANNEL = 'inbox-os:mailbox-changed';
export const AGENT_QUEUE = 'agent-new-mail';

export interface AgentJob { organisationId: string; workspaceId: string; threadId: string; messageId: string; mailboxId: string }

export const hasRedis = () => !!config.REDIS_URL;

export function redis(): Redis {
  if (!config.REDIS_URL) throw new Error('REDIS_URL is not configured');
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

let pub: Redis | null = null;
let agentQueue: Queue<AgentJob> | null = null;

/** Notify the sync worker that a mailbox was created, changed or deleted. */
export async function publishMailboxChange(mailboxId: string): Promise<void> {
  if (config.NODE_ENV === 'test' || !hasRedis()) return;
  pub ??= redis();
  await pub.publish(MAILBOX_CHANNEL, mailboxId);
}

export async function enqueueAgentJob(job: AgentJob): Promise<void> {
  if (!hasRedis()) return;
  agentQueue ??= new Queue<AgentJob>(AGENT_QUEUE, { connection: redis() });
  // No message content in jobs: only IDs.
  await agentQueue.add('new-mail', job, { jobId: `msg-${job.messageId}`, removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
}

export function agentWorker(handler: (job: Job<AgentJob>) => Promise<void>): Worker<AgentJob> {
  return new Worker<AgentJob>(AGENT_QUEUE, handler, { connection: redis(), concurrency: 4 });
}
