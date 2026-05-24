/**
 * BusyBee Multi-Tenant Auth Middleware — P0/P1
 *
 * Enforces authentication on all /mcp requests:
 * 1. Validates Bearer token (API key)
 * 2. Resolves locationId from token or header
 * 3. Injects GHL credentials from credential store
 * 4. Rejects unauthenticated requests
 */

import { Request, Response, NextFunction } from 'express';
import { CredentialStore, getCredentialStore } from './credential-store';
import { randomBytes } from 'crypto';

export interface AuthenticatedRequest extends Request {
  tenant?: {
    locationId: string;
    ghlToken: string;
    expiresIn: number;
  };
}

interface AuthConfig {
  mongoUri: string;
  dbName?: string;
  apiKeys: Map<string, string>; // apiKey -> locationId
  allowHeaderOverride?: boolean;
}

export function createAuthMiddleware(config: AuthConfig) {
  let credStore: CredentialStore | null = null;

  return async function authMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (!credStore) {
      credStore = await getCredentialStore(config.mongoUri, config.dbName);
    }

    try {
      const authHeader = req.headers['authorization'];
      const headerToken = req.headers['x-ghl-access-token'] as string | undefined;
      const headerLocationId = req.headers['x-ghl-location-id'] as string | undefined;

      let locationId: string | null = null;
      let ghlToken: string | null = null;

      // Strategy A: Bearer token -> lookup locationId from API keys
      if (authHeader?.startsWith('Bearer ')) {
        const apiKey = authHeader.slice(7);
        locationId = config.apiKeys.get(apiKey) || null;

        if (!locationId) {
          res.status(401).json({ error: 'Invalid API key', code: 'AUTH_INVALID_KEY' });
          return;
        }
      }
      // Strategy B: Direct header override (if enabled)
      else if (config.allowHeaderOverride && headerToken && headerLocationId) {
        locationId = headerLocationId;
        ghlToken = headerToken;
      }
      // No auth
      else {
        res.status(401).json({
          error: 'Authentication required. Provide Bearer token or x-ghl-access-token + x-ghl-location-id headers.',
          code: 'AUTH_MISSING'
        });
        return;
      }

      // Resolve GHL credential from store
      if (!ghlToken) {
        const cred = await credStore.getCredential(locationId!);
        if (!cred) {
          res.status(403).json({ error: 'No active credential for this location', code: 'AUTH_NO_CREDENTIAL', locationId });
          return;
        }
        ghlToken = cred.token;

        if (cred.expiresIn <= 14) {
          res.setHeader('X-Credential-Expires-In-Days', cred.expiresIn.toString());
          res.setHeader('X-Credential-Warning', 'Token expires soon, rotation recommended');
        }

        req.tenant = { locationId: cred.locationId, ghlToken: cred.token, expiresIn: cred.expiresIn };
      } else {
        req.tenant = { locationId: locationId!, ghlToken, expiresIn: -1 };
      }

      // Inject into downstream GHL calls
      req.headers['x-ghl-access-token'] = ghlToken;
      req.headers['x-ghl-location-id'] = locationId!;

      next();
    } catch (error: any) {
      console.error('[auth-middleware] Error:', error.message);
      res.status(500).json({ error: 'Authentication service error', code: 'AUTH_INTERNAL_ERROR' });
    }
  };
}

export function generateApiKey(): string {
  return `bb_${randomBytes(16).toString('hex')}`;
}

export async function loadApiKeys(mongoUri: string, dbName = 'busybee'): Promise<Map<string, string>> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const keys = await client.db(dbName).collection('api_keys').find({ active: true }).toArray();
  await client.close();
  const map = new Map<string, string>();
  for (const k of keys) map.set(k.key, k.locationId);
  return map;
}
