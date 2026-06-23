/**
 * GHL Affiliate Manager Client
 *
 * Uses the hidden internal GHL affiliate API at backend.leadconnectorhq.com/affiliate-manager.
 * The PUBLIC affiliate API (services.leadconnectorhq.com/affiliates/...) is DEAD (404 for everything),
 * so the dead affiliates-tools.ts was rewritten to call THIS client instead.
 *
 * Auth = the per-tenant session JWT (GHL_AUTH_TOKEN, cron-maintained) as Bearer, with a v2-refresh
 * fallback (GHL_REFRESH_TOKEN -> services.leadconnectorhq.com/auth/refresh) on a 401. Routes are
 * LOCATION-SCOPED path segments (/affiliate-manager/{loc}/...), verified live 2026-06-23.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

export interface AffiliateClientConfig {
  authToken: string;       // session JWT (GHL_AUTH_TOKEN)
  refreshToken?: string;   // v2 30-day refresh token (GHL_REFRESH_TOKEN)
  locationId: string;      // GHL_LOCATION_ID
  envFilePath?: string;    // BUSYBEE_TENANT_ENV — to persist a rotated token
}

export class AffiliateBuilderClient {
  private config: AffiliateClientConfig;

  private static readonly BASE_URL = 'https://backend.leadconnectorhq.com/affiliate-manager';
  private static readonly JWT_REFRESH_URL = 'https://services.leadconnectorhq.com/auth/refresh';

  constructor(config: AffiliateClientConfig) {
    this.config = config;
  }

  /** Build from the worker runtime env (GHL_AUTH_TOKEN + GHL_REFRESH_TOKEN + GHL_LOCATION_ID). */
  static fromEnv(): AffiliateBuilderClient {
    const envPath = process.env.BUSYBEE_TENANT_ENV || '';
    const fileVars: Record<string, string> = {};
    if (envPath && existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) {
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k && v) fileVars[k] = v;
        }
      }
    }
    const get = (k: string): string => process.env[k] || fileVars[k] || '';
    const config: AffiliateClientConfig = {
      authToken: get('GHL_AUTH_TOKEN'),
      refreshToken: get('GHL_REFRESH_TOKEN') || get('GHL_AUTH_REFRESH_TOKEN'),
      locationId: get('GHL_LOCATION_ID'),
      envFilePath: envPath || undefined,
    };
    if (!config.authToken && !config.refreshToken) {
      throw new Error('AffiliateBuilderClient: no GHL_AUTH_TOKEN or GHL_REFRESH_TOKEN in env');
    }
    return new AffiliateBuilderClient(config);
  }

  getLocationId(): string {
    return this.config.locationId;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.authToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'channel': 'APP',
      'source': 'WEB_USER',
      'version': '2021-07-28',
    };
  }

  /** Refresh the session JWT via the v2 refresh endpoint and persist it to the tenant env file. */
  private async refreshJWT(): Promise<boolean> {
    if (!this.config.refreshToken) return false;
    try {
      const res = await fetch(AffiliateBuilderClient.JWT_REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.config.refreshToken }),
      });
      const data = (await res.json()) as { jwt?: string; refreshJwt?: string };
      if ((res.status === 200 || res.status === 201) && data.jwt) {
        this.config.authToken = data.jwt;
        this.persist('GHL_AUTH_TOKEN', data.jwt);
        if (data.refreshJwt && data.refreshJwt !== this.config.refreshToken) {
          this.config.refreshToken = data.refreshJwt;
          this.persist('GHL_REFRESH_TOKEN', data.refreshJwt);
        }
        return true;
      }
    } catch {
      /* non-fatal — surface the original error to the caller */
    }
    return false;
  }

  private persist(key: string, value: string): void {
    const p = this.config.envFilePath;
    if (!p || !existsSync(p)) return;
    try {
      const contents = readFileSync(p, 'utf8');
      const re = new RegExp(`^${key}=.*`, 'm');
      const updated = re.test(contents)
        ? contents.replace(re, `${key}=${value}`)
        : contents.trimEnd() + `\n${key}=${value}\n`;
      writeFileSync(p, updated);
    } catch {
      /* token still valid for this process even if persist fails */
    }
  }

  /**
   * Core request. `path` is appended to the affiliate-manager base (e.g. `/{loc}/campaigns`).
   * Retries once after a JWT refresh on 401/403. Returns parsed JSON (or raw text).
   */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${AffiliateBuilderClient.BASE_URL}${path}`;
    const send = async (): Promise<Response> => {
      const opts: RequestInit = { method, headers: this.headers() };
      if (body !== undefined) opts.body = JSON.stringify(body);
      return fetch(url, opts);
    };

    let res = await send();
    if ((res.status === 401 || res.status === 403) && (await this.refreshJWT())) {
      res = await send();
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(`Affiliate API ${res.status} ${method} ${path}: ${msg}`);
    }
    return data as T;
  }
}
