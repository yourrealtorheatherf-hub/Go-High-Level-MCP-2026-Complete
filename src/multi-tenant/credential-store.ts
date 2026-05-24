/**
 * BusyBee Multi-Tenant Credential Store — P0
 *
 * MongoDB-backed credential isolation layer.
 * Each tenant (GHL sub-account / locationId) has its own PIT token.
 * No more static GHL_API_KEY — every request must carry credentials.
 *
 * Collection: ghl_credentials
 */

import { MongoClient, Db, Collection } from 'mongodb';

export interface GHLCredential {
  locationId: string;
  pit_token: string;
  scopes: string[];
  created_at: Date;
  rotated_at: Date | null;
  expires_at: Date;
  active: boolean;
  metadata?: {
    company_name?: string;
    owner_email?: string;
    onboarded_by?: string;
  };
}

export interface CredentialLookupResult {
  token: string;
  locationId: string;
  expiresIn: number;
}

export class CredentialStore {
  private collection: Collection<GHLCredential>;
  private cache: Map<string, { token: string; expiresAt: number }> = new Map();
  private CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(private db: Db) {
    this.collection = db.collection<GHLCredential>('ghl_credentials');
  }

  async init(): Promise<void> {
    await this.collection.createIndex({ locationId: 1 }, { unique: true });
    await this.collection.createIndex({ expires_at: 1 });
    await this.collection.createIndex({ active: 1 });
  }

  async getCredential(locationId: string): Promise<CredentialLookupResult | null> {
    const cached = this.cache.get(locationId);
    if (cached && cached.expiresAt > Date.now()) {
      const daysLeft = Math.ceil((cached.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
      return { token: cached.token, locationId, expiresIn: daysLeft };
    }

    const cred = await this.collection.findOne({
      locationId,
      active: true,
      expires_at: { $gt: new Date() }
    });

    if (!cred) return null;

    this.cache.set(locationId, {
      token: cred.pit_token,
      expiresAt: Math.min(Date.now() + this.CACHE_TTL_MS, cred.expires_at.getTime())
    });

    const daysLeft = Math.ceil((cred.expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return { token: cred.pit_token, locationId, expiresIn: daysLeft };
  }

  async registerCredential(
    locationId: string,
    pit_token: string,
    scopes: string[],
    metadata?: GHLCredential['metadata']
  ): Promise<void> {
    const now = new Date();
    const expires = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    await this.collection.updateOne(
      { locationId },
      {
        $set: { pit_token, scopes, rotated_at: null, expires_at: expires, active: true, metadata },
        $setOnInsert: { created_at: now }
      },
      { upsert: true }
    );

    this.cache.set(locationId, { token: pit_token, expiresAt: expires.getTime() });
  }

  async rotateCredential(locationId: string, newToken: string): Promise<void> {
    const now = new Date();
    const expires = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    await this.collection.updateOne(
      { locationId, active: true },
      { $set: { pit_token: newToken, rotated_at: now, expires_at: expires } }
    );
    this.cache.delete(locationId);
  }

  async deactivateCredential(locationId: string): Promise<void> {
    await this.collection.updateOne({ locationId }, { $set: { active: false } });
    this.cache.delete(locationId);
  }

  async getExpiringCredentials(withinDays: number): Promise<GHLCredential[]> {
    const threshold = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    return this.collection.find({ active: true, expires_at: { $lte: threshold } }).toArray();
  }

  async listActive(): Promise<GHLCredential[]> {
    return this.collection.find({ active: true }).toArray();
  }
}

let _store: CredentialStore | null = null;

export async function getCredentialStore(mongoUri: string, dbName = 'busybee'): Promise<CredentialStore> {
  if (_store) return _store;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);
  _store = new CredentialStore(db);
  await _store.init();
  return _store;
}
