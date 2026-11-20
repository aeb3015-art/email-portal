import type { Request, Response, Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../logger.js';
import { descriptions, resolveMcpToken, schemas, tools, type McpContext } from './tools.js';

function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'inbox-os', version: '0.1.0' });
  for (const name of Object.keys(tools) as (keyof typeof tools)[]) {
    const readOnly = ['list_mailboxes', 'list_threads', 'get_thread', 'search_messages', 'list_pending_approvals'].includes(name);
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: schemas[name] as any,
        annotations: { readOnlyHint: readOnly, destructiveHint: name === 'send_draft', openWorldHint: name === 'send_draft' },
      },
      async (args: any) => {
        try {
          const result = await (tools[name] as (c: McpContext, a: unknown) => Promise<unknown>)(ctx, args ?? {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const e = err as { message?: string; code?: string };
          logger.info({ tool: name, code: e.code }, 'mcp tool error');
          return { isError: true, content: [{ type: 'text' as const, text: e.message ?? 'Tool failed' }] };
        }
      },
    );
  }
  return server;
}

const mcpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.headers.authorization ?? req.ip ?? 'anon').slice(-24),
});

/** Stateless Streamable HTTP: a fresh server + transport per request, scoped to the bearer token. */
export function mcpRouter(): Router {
  const r = express.Router();
  r.use(mcpLimiter);
  r.post('/', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let ctx: McpContext | null = null;
    try {
      ctx = await resolveMcpToken(token);
    } catch {
      ctx = null;
    }
    if (!ctx) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked token' }, id: null });
      return;
    }
    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
      ctx?.crypto.dispose().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
    } catch (err) {
      logger.error({ code: (err as { code?: string }).code }, 'mcp request failed');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) => { res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }); };
  r.get('/', notAllowed);
  r.delete('/', notAllowed);
  return r;
}
