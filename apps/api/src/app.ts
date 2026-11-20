import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { HttpError } from './errors.js';
import { logger } from './logger.js';
import { mcpRouter } from './mcp/server.js';
import { authRouter } from './routes/auth.js';
import { inboxRouter } from './routes/inbox.js';
import { mailboxRouter } from './routes/mailboxes.js';
import { oauthRouter } from './routes/oauth.js';
import { orgRouter } from './routes/org.js';
import { workspaceRouter } from './routes/workspaces.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, role: 'api' });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // MCP is called by Claude / other MCP clients, not by the browser: no CORS.
  app.use('/mcp', mcpRouter());

  const origins = config.WEB_ORIGIN.split(',').map((s) => s.trim());
  app.use(cors({ origin: origins, credentials: false, allowedHeaders: ['authorization', 'content-type', 'x-org-id'], maxAge: 600 }));
  app.use(express.json({ limit: '25mb' }));

  // Minimal request logging: method, path, status, duration. Never bodies or headers.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => logger.info({ method: req.method, path: req.route?.path ?? req.path.replace(/[0-9a-f-]{36}/g, ':id'), status: res.statusCode, ms: Date.now() - start }, 'request'));
    next();
  });

  app.use('/auth', authRouter);
  app.use('/oauth', oauthRouter);
  app.use('/org', orgRouter);
  app.use('/workspaces', workspaceRouter);
  app.use('/mailboxes', mailboxRouter);
  app.use('/inbox', inboxRouter);

  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'Not found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'validation_error', message: 'Invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const e = err as { status?: number; code?: string; message?: string; type?: string };
    if (err instanceof HttpError || (e.status && e.status < 500)) return res.status(e.status!).json({ error: e.code ?? 'error', message: e.message });
    if (e.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Request too large' });
    logger.error({ err: e.message, code: e.code }, 'unhandled error');
    res.status(500).json({ error: 'internal', message: 'Internal server error' });
  });
  return app;
}
