import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export class ProviderError extends Error {
  constructor(code) { super(code); this.name = 'ProviderError'; this.code = code; }
}
const digest = value => createHash('sha256').update(value).digest('hex');
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProviderError('INVALID_INPUT');
  return value.trim();
}
function cents(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ProviderError('INVALID_AMOUNT');
  return value;
}
function storageKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new ProviderError('INVALID_STORAGE_KEY');
  return value;
}

// This is a development adapter, not a payment gateway, SMS sender or AI decision engine.
export function createLocalProviders({ directory, mode = 'local', storageMaxBytes = 1024 * 1024, environment = process.env.APP_ENV || (process.env.NODE_ENV === 'test' ? 'test' : 'local'), allowStagingMocks = false }) {
  const staging = environment === 'staging' && process.env.NODE_ENV === 'production' && allowStagingMocks === true;
  if (mode !== 'local' || !['local', 'test', 'staging'].includes(environment) || (environment === 'staging' && !staging) || (process.env.NODE_ENV === 'production' && !staging)) throw new ProviderError('MOCK_NOT_ALLOWED');
  if (!Number.isSafeInteger(storageMaxBytes) || storageMaxBytes <= 0 || storageMaxBytes > 20 * 1024 * 1024) throw new ProviderError('INVALID_STORAGE_LIMIT');
  mkdirSync(directory, { recursive: true });
  const storageDirectory = path.join(directory, 'storage');
  mkdirSync(storageDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'mock-services.sqlite'));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS mock_operations (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, action TEXT NOT NULL,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(provider, action, request_id)
    );`);
  const rows = (provider, action) => database.prepare('SELECT result FROM mock_operations WHERE provider=? AND action=? ORDER BY created_at,id').all(provider, action).map(row => JSON.parse(row.result));
  const lookup = id => {
    const row = database.prepare('SELECT result FROM mock_operations WHERE id=?').get(text(id));
    return row ? JSON.parse(row.result) : null;
  };
  function record(provider, action, requestId, fingerprintInput, operation) {
    requestId = text(requestId, 128);
    const fingerprint = digest(JSON.stringify(fingerprintInput));
    database.exec('BEGIN IMMEDIATE');
    try {
      const previous = database.prepare('SELECT fingerprint,result FROM mock_operations WHERE provider=? AND action=? AND request_id=?').get(provider, action, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ProviderError('IDEMPOTENCY_CONFLICT');
        database.exec('COMMIT'); return JSON.parse(previous.result);
      }
      const result = { id: `mock_${randomUUID()}`, simulated: true, createdAt: new Date().toISOString(), ...operation() };
      database.prepare('INSERT INTO mock_operations VALUES (?,?,?,?,?,?,?)').run(result.id, provider, action, requestId, fingerprint, JSON.stringify(result), result.createdAt);
      database.exec('COMMIT'); return result;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  const lookupRequest = (action, requestId) => {
    const row = database.prepare("SELECT result FROM mock_operations WHERE provider='payment' AND action=? AND request_id=?").get(action, text(requestId, 128));
    return row ? JSON.parse(row.result) : null;
  };
  const payment = {
    async findPayment(requestId) { return lookupRequest('create', requestId); },
    async findRefund(requestId) { return lookupRequest('refund', requestId); },
    async createPayment({ reference, amountCents, requestId }) {
      reference = text(reference); amountCents = cents(amountCents);
      return record('payment', 'create', requestId, { reference, amountCents }, () => ({ status: 'succeeded', reference, amountCents, currency: 'CNY' }));
    },
    async getPayment(id) {
      const result = lookup(id);
      if (!result || !Object.hasOwn(result, 'reference')) return null;
      const refundedCents = rows('payment', 'refund').filter(row => row.paymentId === id).reduce((sum, row) => sum + row.amountCents, 0);
      return { ...result, refundedCents, status: refundedCents === result.amountCents ? 'refunded' : refundedCents ? 'partially_refunded' : 'succeeded' };
    },
    async refund({ paymentId, amountCents, requestId, reason }) {
      paymentId = text(paymentId); amountCents = cents(amountCents); reason = text(reason);
      return record('payment', 'refund', requestId, { paymentId, amountCents, reason }, () => {
        const original = lookup(paymentId);
        if (!original || !Object.hasOwn(original, 'reference')) throw new ProviderError('PAYMENT_NOT_FOUND');
        const refunded = rows('payment', 'refund').filter(row => row.paymentId === paymentId).reduce((sum, row) => sum + row.amountCents, 0);
        if (amountCents > original.amountCents - refunded) throw new ProviderError('REFUND_EXCEEDS_PAYMENT');
        return { status: 'refunded', paymentId, amountCents, reason };
      });
    },
  };
  const ai = { async analyze({ text: input, requestId }) {
    const contentHash = digest(text(input, 20_000));
    return record('ai', 'analyze', requestId, { contentHash }, () => ({ status: 'mock_only', needsHumanReview: true, findings: ['MOCK_NO_ANALYSIS'], contentHash }));
  } };
  const sms = { async send({ recipient, template, requestId }) {
    const recipientHash = digest(text(recipient)); template = text(template);
    return record('sms', 'send', requestId, { recipientHash, template }, () => ({ status: 'recorded', delivered: false, recipientHash, template }));
  } };
  const notification = { async send({ userId, topic, requestId }) {
    const recipientHash = digest(text(userId)); topic = text(topic);
    return record('notification', 'send', requestId, { recipientHash, topic }, () => ({ status: 'recorded', delivered: false, recipientHash, topic }));
  } };
  const storage = {
    async put({ key, content, requestId }) {
      key = storageKey(key);
      if (!(content instanceof Uint8Array) || content.byteLength > storageMaxBytes) throw new ProviderError('INVALID_CONTENT');
      const contentHash = digest(content);
      return record('storage', 'put', requestId, { key, contentHash }, () => {
        const filename = path.join(storageDirectory, key);
        // Immutable keys avoid silently overwriting evidence or earlier test files.
        try { if (digest(readFileSync(filename)) !== contentHash) throw new ProviderError('STORAGE_KEY_EXISTS'); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const temporary = path.join(storageDirectory, `.pending-${randomUUID()}`);
          try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, filename); }
          finally { try { unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } }
        }
        return { status: 'stored_local', key, bytes: content.byteLength, contentHash };
      });
    },
    async get(key) {
      try { return readFileSync(path.join(storageDirectory, storageKey(key))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
  };
  return { payment, ai, sms, notification, storage,
    health: () => ({ mode: 'local', simulated: true, database: database.prepare('PRAGMA quick_check').get().quick_check, operations: database.prepare('SELECT COUNT(*) n FROM mock_operations').get().n }),
    close: () => database.close(),
  };
}
