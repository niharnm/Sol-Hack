import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class PurchaseStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA locking_mode = EXCLUSIVE;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_attempts (
        id TEXT PRIMARY KEY, channel_id TEXT UNIQUE NOT NULL, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY, quote_id TEXT UNIQUE NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL, channel_id TEXT UNIQUE NOT NULL,
        document TEXT NOT NULL
      );
    `);
    for (const row of this.db.prepare('SELECT document FROM payment_attempts').all()) {
      const attempt = JSON.parse(row.document);
      if (attempt.status === 'authorizing') this.saveAttempt({ ...attempt, status: 'interrupted', updated_at: new Date().toISOString() });
    }
    for (const row of this.db.prepare('SELECT document FROM purchases').all()) {
      const purchase = JSON.parse(row.document);
      if (['fetching', 'validating', 'settling'].includes(purchase.status)) {
        this.updatePurchase({ ...purchase, status: 'interrupted', charged_usd: null, returned_usd: null,
          reason: 'The service restarted before settlement was recorded. Payment is unconfirmed. Inspect this purchase before authorizing another.',
          updated_at: new Date().toISOString() });
      }
    }
  }

  saveQuote(quote) {
    this.db.prepare('INSERT INTO quotes (id, document) VALUES (?, ?)').run(quote.id, JSON.stringify(quote));
    return quote;
  }

  quote(id) {
    const row = this.db.prepare('SELECT document FROM quotes WHERE id = ?').get(id);
    return row ? JSON.parse(row.document) : undefined;
  }

  createPurchase(purchase, key, channelId) {
    this.db.prepare('INSERT INTO purchases (id, quote_id, idempotency_key, channel_id, document) VALUES (?, ?, ?, ?, ?)')
      .run(purchase.id, purchase.quote_id, key, channelId, JSON.stringify(purchase));
    return purchase;
  }

  updatePurchase(purchase) {
    const result = this.db.prepare('UPDATE purchases SET document = ? WHERE id = ?').run(JSON.stringify(purchase), purchase.id);
    if (result.changes !== 1) throw new Error('purchase record does not exist');
    return purchase;
  }

  purchase(id) { return this.lookup('id', id); }
  purchaseForQuote(id) { return this.lookup('quote_id', id); }
  purchaseForKey(key) { return this.lookup('idempotency_key', key); }
  purchaseForChannel(id) { return this.lookup('channel_id', id); }

  lookup(column, value) {
    const row = this.db.prepare(`SELECT document FROM purchases WHERE ${column} = ?`).get(value);
    return row ? JSON.parse(row.document) : undefined;
  }

  purchases(limit = 100) {
    return this.db.prepare('SELECT document FROM purchases ORDER BY rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(row.document));
  }

  saveAttempt(attempt) {
    this.db.prepare('INSERT INTO payment_attempts (id, channel_id, document) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET document = excluded.document')
      .run(attempt.id, attempt.payment_channel_id, JSON.stringify(attempt));
    return attempt;
  }

  attemptForChannel(channelId) {
    const row = this.db.prepare('SELECT document FROM payment_attempts WHERE channel_id = ?').get(channelId);
    return row ? JSON.parse(row.document) : undefined;
  }

  attemptForQuote(id) {
    const row = this.db.prepare("SELECT document FROM payment_attempts WHERE json_extract(document, '$.quote_id') = ? AND json_extract(document, '$.status') IN ('authorizing', 'interrupted', 'unconfirmed') ORDER BY rowid DESC LIMIT 1").get(id);
    return row ? JSON.parse(row.document) : undefined;
  }

  attemptForKey(key) {
    const row = this.db.prepare("SELECT document FROM payment_attempts WHERE json_extract(document, '$.idempotency_key') = ? AND json_extract(document, '$.status') IN ('authorizing', 'interrupted', 'unconfirmed') ORDER BY rowid DESC LIMIT 1").get(key);
    return row ? JSON.parse(row.document) : undefined;
  }

  attempts() {
    return this.db.prepare('SELECT document FROM payment_attempts ORDER BY rowid DESC LIMIT 100').all().map(row => JSON.parse(row.document));
  }

  close() { this.db.close(); }
}
