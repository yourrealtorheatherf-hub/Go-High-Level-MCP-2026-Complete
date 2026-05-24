/**
 * GoHighLevel MCP Server — Multi-Tenant Edition
 *
 * Streamable HTTP transport with mandatory per-tenant authentication.
 * All /mcp requests MUST carry a Bearer API key (or x-ghl-access-token +
 * x-ghl-location-id headers in dev mode). Static GHL_API_KEY env var
 * fallback has been intentionally removed.
 *
 * Multi-tenant security layer wired in: May 2026
 */

import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { EnhancedGHLClient } from './enhanced-ghl-client.js';
import { ToolRegistry } from './tool-registry.js';
import { GHLConfig } from './types/ghl-types.js';
import { initMultiTenantSecurity, AuthenticatedRequest } from './multi-tenant/index.js';

dotenv.config();

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;
  const out = process.stderr;
  out.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data || {}) }) + '\n');
}

/** Build a per-request GHL config from authenticated tenant context */
function tenantConfig(req: AuthenticatedRequest): GHLConfig {
  const tenant = req.tenant!;
  return {
    accessToken: tenant.ghlToken,
    baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
    version: process.env.GHL_API_VERSION || '2021-07-28',
    locationId: tenant.locationId,
  };
}

function createMcpServer(client: EnhancedGHLClient): McpServer {
  const server = new McpServer(
    { name: 'ghl-mcp-server', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );
  new ToolRegistry(client).registerAll(server);
  return server;
}

async function main() {
  const port = parseInt(process.env.PORT || process.env.MCP_SERVER_PORT || '3001', 10);
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const startTime = Date.now();

  if (!mongoUri) {
    throw new Error('[multi-tenant] MONGO_URI is required. Set it in your environment.');
  }

  log('info', 'Initializing multi-tenant GHL MCP server', {
    port,
    mongoUri: mongoUri.replace(/:([^@]+)@/, ':***@'),
  });

  // ── Multi-Tenant Security Layer ─────────────────────────────────────────────
  const security = await initMultiTenantSecurity({
    mongoUri,
    dbName: process.env.MONGO_DB || 'busybee',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    // Allow direct header override when not in production (dev/testing)
    allowHeaderOverride: process.env.NODE_ENV !== 'production',
  });

  log('info', 'Multi-tenant security initialized');

  // Lightweight client for tool count only — no live API calls at boot
  const baseConfig: GHLConfig = {
    accessToken: 'multi-tenant-mode',
    baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
    version: process.env.GHL_API_VERSION || '2021-07-28',
    locationId: 'multi-tenant-mode',
  };
  const baseClient = new EnhancedGHLClient(baseConfig);
  const baseRegistry = new ToolRegistry(baseClient);
  const toolCount = baseRegistry.getToolCount();

  // ── Express App ─────────────────────────────────────────────────────────────
  const app = express();

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin) ||
          origin === 'https://chatgpt.com' ||
          origin === 'https://chat.openai.com' ||
          origin === 'https://claude.ai') {
        return callback(null, true);
      }
      callback(new Error('CORS not allowed'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'Accept',
      'mcp-session-id', 'x-ghl-access-token', 'x-ghl-location-id',
    ],
    credentials: true,
  }));

  // PATCH 1: 50MB body limit (source-sync-patches Patch 1)
  app.use(express.json({ limit: '50mb' }));

  app.use((req, _res, next) => {
    log('debug', `${req.method} ${req.path}`, { ip: req.ip });
    next();
  });

  // ── Public endpoints (no auth) ──────────────────────────────────────────────

  app.get('/', (_req, res) => {
    res.json({
      name: 'GoHighLevel MCP Server (Multi-Tenant)',
      version: '2.0.0',
      mode: 'multi-tenant',
      status: 'running',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      endpoints: { health: '/health', capabilities: '/capabilities', mcp: '/mcp', sse: '/sse' },
      tools: { total: toolCount },
      auth: 'Bearer token required for /mcp',
    });
  });

  app.get('/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: 'healthy',
      server: 'ghl-mcp-server',
      version: '2.0.0',
      mode: 'multi-tenant',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      tools: toolCount,
      memory: {
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      },
    });
  });

  app.get('/capabilities', (_req, res) => {
    res.json({
      capabilities: { tools: {} },
      server: { name: 'ghl-mcp-server', version: '2.0.0' },
      transport: ['streamable-http', 'sse'],
      auth: 'bearer-token',
    });
  });

  // ── Protected /mcp — auth + rate limit mandatory ────────────────────────────

  app.all('/mcp', security.authMiddleware, security.rateLimitMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const cfg = tenantConfig(req);
      const client = new EnhancedGHLClient(cfg);
      const requestServer = createMcpServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        requestServer.close().catch(() => {});
      });
    } catch (err: any) {
      log('error', 'Streamable HTTP error', { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── SSE — auth required ─────────────────────────────────────────────────────

  const handleSSE = async (req: AuthenticatedRequest, res: express.Response) => {
    const sessionId = String(req.query.sessionId || 'unknown');
    log('info', 'SSE connection', { sessionId, locationId: req.tenant?.locationId });
    try {
      const cfg = tenantConfig(req);
      const client = new EnhancedGHLClient(cfg);
      const sseServer = createMcpServer(client);
      const transport = new SSEServerTransport('/sse', res);
      await sseServer.connect(transport);
      req.on('close', () => {
        log('info', 'SSE connection closed', { sessionId });
        sseServer.close().catch(() => {});
      });
    } catch (err: any) {
      log('error', 'SSE error', { error: err.message, sessionId });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to establish SSE connection' });
      else res.end();
    }
  };

  app.get('/sse', security.authMiddleware, handleSSE);
  app.post('/sse', security.authMiddleware, handleSSE);

  // ── Admin credential management API ────────────────────────────────────────

  app.post('/admin/credentials', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET) {
      res.status(403).json({ error: 'Admin key required' });
      return;
    }
    const { locationId, pitToken, scopes, metadata } = req.body;
    if (!locationId || !pitToken) {
      res.status(400).json({ error: 'locationId and pitToken required' });
      return;
    }
    try {
      await security.credStore.registerCredential(locationId, pitToken, scopes || [], metadata);
      res.json({ success: true, locationId });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/admin/credentials', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET) {
      res.status(403).json({ error: 'Admin key required' });
      return;
    }
    const creds = await security.credStore.listActive();
    res.json({
      credentials: creds.map(c => ({
        locationId: c.locationId,
        expires_at: c.expires_at,
        active: c.active,
        metadata: c.metadata,
      })),
    });
  });

  // ── Start server ────────────────────────────────────────────────────────────

  app.listen(port, '0.0.0.0', () => {
    console.log('GoHighLevel MCP Server v2.0 — Multi-Tenant Edition');
    console.log(`Server:           http://0.0.0.0:${port}`);
    console.log(`Streamable HTTP:  http://0.0.0.0:${port}/mcp  [AUTH REQUIRED]`);
    console.log(`Legacy SSE:       http://0.0.0.0:${port}/sse  [AUTH REQUIRED]`);
    console.log(`Tools:            ${toolCount}`);
    console.log(`Auth:             Bearer token (MongoDB-backed API keys)`);
    console.log(`Admin:            POST /admin/credentials (x-admin-key required)`);
  });

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log('info', `Shutting down (${sig})`);
      await security.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log('error', 'Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
