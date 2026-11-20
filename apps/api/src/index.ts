import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { logger } from './logger.js';
import { handleNewMail } from './agent/newMail.js';
import { agentWorker } from './queue/index.js';

async function main() {
  await migrate();
  const app = createApp();
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));
  // The API (which may hold unlocked keys in memory) consumes new-mail agent jobs.
  const worker = agentWorker(handleNewMail);
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message.slice(0, 120) }, 'agent job failed'));
  const shutdown = () => {
    server.close();
    worker.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'api failed to start');
  process.exit(1);
});
