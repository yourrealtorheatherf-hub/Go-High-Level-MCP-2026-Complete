const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

const MONGO_URI = process.env.MONGO_URI;
const DB = 'busybee';

function generateApiKey() {
  return 'bb_' + crypto.randomBytes(16).toString('hex');
}

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB);
  const creds = db.collection('ghl_credentials');
  const keys = db.collection('api_keys');

  // Create indexes
  await creds.createIndex({ locationId: 1 }, { unique: true });
  await creds.createIndex({ active: 1 });
  await keys.createIndex({ key: 1 }, { unique: true });
  await keys.createIndex({ locationId: 1 });

  const now = new Date();
  const expires = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  // Tenant 1: Real Talk BizDev
  const loc1 = 'ifitVy09cFwlEVgEAFDS';
  const pit1 = process.env.GHL_BIZDEV_PIT_TOKEN;
  await creds.updateOne(
    { locationId: loc1 },
    { $set: { pit_token: pit1, scopes: ['contacts.readonly','contacts.write','conversations.readonly','conversations.write','opportunities.readonly','opportunities.write','workflows.readonly'], expires_at: expires, active: true, rotated_at: null, metadata: { company_name: 'Real Talk BizDev', onboarded_by: 'migration-script-2026' } }, $setOnInsert: { created_at: now } },
    { upsert: true }
  );
  console.log('✅ Credential registered:', loc1);

  // Generate API key for loc1
  const apiKey1 = generateApiKey();
  await keys.updateOne(
    { locationId: loc1 },
    { $set: { key: apiKey1, locationId: loc1, active: true, created_at: now, metadata: { name: 'Real Talk BizDev - auto' } } },
    { upsert: true }
  );
  console.log('✅ API key generated for', loc1, ':', apiKey1);

  await client.close();
}

migrate().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
