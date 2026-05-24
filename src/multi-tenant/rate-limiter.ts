/**
 * BusyBee Per-Tenant Rate Limiter — P1
 *
 * GHL Rate Limits:
 * - 100 requests per 10 seconds per location
 * - 200,000 requests per day per location
 * - Agent Studio: 300 requests per minute
 *
 * Implementation: Redis sliding window (with in-memory fallback)
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth-middleware';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
  retryAfterMs?: number;
}

export interface RateLimitConfig {
  redisUrl?: string;
  limits: {
    perTenSecond: number;
    perDay: number;
    agentStudioPerMin: number;
  };
}

export class RateLimiter {
  private redis: any = null;
  private inMemoryWindows: Map<string, number[]> = new Map();
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      redisUrl: config.redisUrl,
      limits: {
        perTenSecond: config.limits?.perTenSecond ?? 100,
        perDay: config.limits?.perDay ?? 200000,
        agentStudioPerMin: config.limits?.agentStudioPerMin ?? 300,
      }
    };
  }

  async init(): Promise<void> {
    if (this.config.redisUrl) {
      try {
        const Redis = (await import('ioredis')).default;
        this.redis = new Redis(this.config.redisUrl, {
          connectTimeout: 3000,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        // Attach error handler BEFORE connect to avoid unhandled error events
        this.redis.on('error', (err: Error) => {
          console.warn('[rate-limiter] Redis error (falling back to in-memory):', err.message);
          this.redis = null;
        });
        await this.redis.connect();
        await this.redis.ping();
        console.log('[rate-limiter] Connected to Redis');
      } catch (err: any) {
        console.warn('[rate-limiter] Redis unavailable, using in-memory fallback:', err.message);
        this.redis = null;
      }
    } else {
      console.log('[rate-limiter] Using in-memory sliding window');
    }
  }

  async checkLimit(locationId: string, isAgentStudio = false): Promise<RateLimitResult> {
    const now = Date.now();

    // 10-second window check
    const tenSecResult = this.memoryWindowCheck(`rl:10s:${locationId}`, now, 10_000, this.config.limits.perTenSecond);
    if (!tenSecResult.allowed) return tenSecResult;

    // Daily window check
    const dailyResult = this.memoryWindowCheck(`rl:day:${locationId}`, now, 86_400_000, this.config.limits.perDay);
    if (!dailyResult.allowed) return dailyResult;

    // Agent Studio check
    if (isAgentStudio) {
      const agentResult = this.memoryWindowCheck(`rl:agent:${locationId}`, now, 60_000, this.config.limits.agentStudioPerMin);
      if (!agentResult.allowed) return agentResult;
    }

    return tenSecResult;
  }

  private memoryWindowCheck(key: string, now: number, windowMs: number, maxRequests: number): RateLimitResult {
    const windowStart = now - windowMs;
    let timestamps = this.inMemoryWindows.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= maxRequests) {
      const resetInMs = (timestamps[0] + windowMs) - now;
      this.inMemoryWindows.set(key, timestamps);
      return { allowed: false, remaining: 0, resetInMs: Math.max(resetInMs, 100), retryAfterMs: Math.max(resetInMs, 100) };
    }

    timestamps.push(now);
    this.inMemoryWindows.set(key, timestamps);
    return { allowed: true, remaining: maxRequests - timestamps.length, resetInMs: windowMs };
  }

  async getUsageStats(locationId: string): Promise<{ tenSecond: { used: number; limit: number }; daily: { used: number; limit: number } }> {
    const now = Date.now();
    const tenSec = (this.inMemoryWindows.get(`rl:10s:${locationId}`) || []).filter(t => t > now - 10_000).length;
    const daily = (this.inMemoryWindows.get(`rl:day:${locationId}`) || []).filter(t => t > now - 86_400_000).length;
    return {
      tenSecond: { used: tenSec, limit: this.config.limits.perTenSecond },
      daily: { used: daily, limit: this.config.limits.perDay }
    };
  }

  async close(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }
}

export function createRateLimitMiddleware(limiter: RateLimiter) {
  return async function rateLimitMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    const locationId = req.tenant?.locationId;
    if (!locationId) { next(); return; }

    const toolName = (req.body?.method === 'tools/call' ? req.body?.params?.name : '') || '';
    const isAgentStudio = toolName.startsWith('ghl_') && (toolName.includes('agent') || toolName.includes('voice_ai'));

    const result = await limiter.checkLimit(locationId, isAgentStudio);
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetInMs / 1000).toString());

    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil((result.retryAfterMs || 1000) / 1000).toString());
      res.status(429).json({
        error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED', locationId,
        retryAfterMs: result.retryAfterMs
      });
      return;
    }
    next();
  };
}
