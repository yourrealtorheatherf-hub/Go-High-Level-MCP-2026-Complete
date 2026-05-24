/**
 * BusyBee Structured Audit Logger — P1
 *
 * Logs every MCP tool call with:
 * timestamp, locationId, tool_name, args_hash, success, duration_ms, error
 *
 * Dual output: MongoDB + structured JSON stdout
 */

import { createHash } from 'crypto';
import { Db, Collection } from 'mongodb';

export interface AuditEntry {
  timestamp: Date;
  locationId: string;
  tool_name: string;
  args_hash: string;
  success: boolean;
  duration_ms: number;
  status_code?: number;
  error?: string;
  request_id: string;
  ip?: string;
}

export class AuditLogger {
  private collection: Collection<AuditEntry> | null = null;
  private buffer: AuditEntry[] = [];
  private flushTimer: NodeJS.Timer | null = null;
  private batchSize: number;
  private logToStdout: boolean;

  constructor(options: { batchSize?: number; flushIntervalMs?: number; logToStdout?: boolean } = {}) {
    this.batchSize = options.batchSize ?? 50;
    this.logToStdout = options.logToStdout ?? true;

    this.flushTimer = setInterval(() => this.flush(), options.flushIntervalMs ?? 5000);
  }

  async init(db: Db): Promise<void> {
    this.collection = db.collection<AuditEntry>('audit_logs');
    await this.collection.createIndex({ timestamp: -1 });
    await this.collection.createIndex({ locationId: 1, timestamp: -1 });
    await this.collection.createIndex({ tool_name: 1 });
    await this.collection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
  }

  log(entry: { locationId: string; tool_name: string; args?: any; success: boolean; duration_ms: number; status_code?: number; error?: string; ip?: string }): void {
    const fullEntry: AuditEntry = {
      timestamp: new Date(),
      locationId: entry.locationId,
      tool_name: entry.tool_name,
      args_hash: entry.args ? createHash('sha256').update(JSON.stringify(entry.args)).digest('hex').slice(0, 16) : 'none',
      success: entry.success,
      duration_ms: entry.duration_ms,
      status_code: entry.status_code,
      error: entry.error,
      request_id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ip: entry.ip
    };

    if (this.logToStdout) {
      process.stdout.write(JSON.stringify({ level: fullEntry.success ? 'info' : 'error', msg: `[audit] ${fullEntry.tool_name}`, ...fullEntry, timestamp: fullEntry.timestamp.toISOString() }) + '\n');
    }

    if (this.collection) {
      this.buffer.push(fullEntry);
      if (this.buffer.length >= this.batchSize) this.flush();
    }
  }

  startTimer(locationId: string, tool_name: string, args?: any): { success: (sc?: number) => void; fail: (err: string, sc?: number) => void } {
    const start = Date.now();
    return {
      success: (sc?: number) => this.log({ locationId, tool_name, args, success: true, duration_ms: Date.now() - start, status_code: sc }),
      fail: (err: string, sc?: number) => this.log({ locationId, tool_name, args, success: false, duration_ms: Date.now() - start, error: err, status_code: sc })
    };
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.collection) return;
    const batch = this.buffer.splice(0);
    try {
      await this.collection.insertMany(batch, { ordered: false });
    } catch (e: any) {
      console.error(`[audit-logger] Flush failed: ${e.message}`);
      if (this.buffer.length < 1000) this.buffer.unshift(...batch);
    }
  }

  async query(filter: { locationId?: string; tool_name?: string; success?: boolean; from?: Date; to?: Date }, limit = 100): Promise<AuditEntry[]> {
    if (!this.collection) return [];
    const q: any = {};
    if (filter.locationId) q.locationId = filter.locationId;
    if (filter.tool_name) q.tool_name = filter.tool_name;
    if (filter.success !== undefined) q.success = filter.success;
    if (filter.from || filter.to) { q.timestamp = {}; if (filter.from) q.timestamp.$gte = filter.from; if (filter.to) q.timestamp.$lte = filter.to; }
    return this.collection.find(q).sort({ timestamp: -1 }).limit(limit).toArray();
  }

  async getStats(locationId: string, periodHours = 24) {
    if (!this.collection) return { total: 0, success: 0, failed: 0, avgDurationMs: 0, topTools: [] };
    const since = new Date(Date.now() - periodHours * 60 * 60 * 1000);
    const [stats] = await this.collection.aggregate([
      { $match: { locationId, timestamp: { $gte: since } } },
      { $group: { _id: null, total: { $sum: 1 }, success: { $sum: { $cond: ['$success', 1, 0] } }, failed: { $sum: { $cond: ['$success', 0, 1] } }, avgDuration: { $avg: '$duration_ms' } } }
    ]).toArray();
    const topTools = await this.collection.aggregate([
      { $match: { locationId, timestamp: { $gte: since } } },
      { $group: { _id: '$tool_name', count: { $sum: 1 } } },
      { $sort: { count: -1 } }, { $limit: 10 }
    ]).toArray();
    return { total: stats?.total || 0, success: stats?.success || 0, failed: stats?.failed || 0, avgDurationMs: Math.round(stats?.avgDuration || 0), topTools: topTools.map(t => ({ tool: t._id, count: t.count })) };
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
