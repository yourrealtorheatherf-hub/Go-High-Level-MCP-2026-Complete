/**
 * BusyBee Multi-Tenant Security Layer — Integration Entry Point
 *
 * Usage in BusyBee's main.ts or http-server.ts:
 *
 *   import { initMultiTenantSecurity } from './multi-tenant';
 *   const { authMiddleware, rateLimitMiddleware, auditLogger } = await initMultiTenantSecurity({
 *     mongoUri: process.env.MONGODB_URI!,
 *     redisUrl: process.env.REDIS_URL,
 *   });
 *   app.use('/mcp', authMiddleware, rateLimitMiddleware);
 */

import { MongoClient } from 'mongodb';
import { createAuthMiddleware, loadApiKeys, AuthenticatedRequest } from './auth-middleware';
import { RateLimiter, createRateLimitMiddleware } from './rate-limiter';
import { AuditLogger } from './audit-logger';
import { CredentialStore } from './credential-store';

export interface MultiTenantConfig {
  mongoUri: string;
  dbName?: string;
  redisUrl?: string;
  allowHeaderOverride?: boolean; // Allow direct x-ghl-access-token (for dev/testing)
}

export async function initMultiTenantSecurity(config: MultiTenantConfig) {
  const dbName = config.dbName || 'busybee';

  // Connect to MongoDB
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const db = client.db(dbName);

  // Initialize credential store
  const credStore = new CredentialStore(db);
  await credStore.init();

  // Load API keys
  const apiKeys = await loadApiKeys(config.mongoUri, dbName);
  console.log(`[multi-tenant] Loaded ${apiKeys.size} API keys`);

  // Initialize rate limiter
  const rateLimiter = new RateLimiter({ redisUrl: config.redisUrl });
  await rateLimiter.init();

  // Initialize audit logger
  const auditLogger = new AuditLogger();
  await auditLogger.init(db);

  // Create middlewares
  const authMiddleware = createAuthMiddleware({
    mongoUri: config.mongoUri,
    dbName,
    apiKeys,
    allowHeaderOverride: config.allowHeaderOverride ?? false,
  });

  const rateLimitMiddleware = createRateLimitMiddleware(rateLimiter);

  return {
    authMiddleware,
    rateLimitMiddleware,
    auditLogger,
    credStore,
    rateLimiter,

    // Graceful shutdown
    async shutdown() {
      await auditLogger.close();
      await rateLimiter.close();
      await client.close();
    }
  };
}

// Re-export everything
export { CredentialStore, getCredentialStore } from './credential-store';
export { createAuthMiddleware, generateApiKey, loadApiKeys, AuthenticatedRequest } from './auth-middleware';
export { RateLimiter, createRateLimitMiddleware } from './rate-limiter';
export { AuditLogger } from './audit-logger';
