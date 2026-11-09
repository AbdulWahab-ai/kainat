// Unit tests for the database layer: helpers, transactions and upgrading an older database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Build a database with the first release's schema (no bidding columns, no chat tables) before the module opens it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kainat-db-'));
const legacy = new DatabaseSync(path.join(dir, 'app.db'));
legacy.exec(`
  CREATE TABLE businesses (id INTEGER PRIMARY KEY, role TEXT NOT NULL, supplier_type TEXT, name TEXT NOT NULL, city TEXT, address TEXT,
    contact TEXT, phone TEXT UNIQUE NOT NULL, whatsapp TEXT, ntn TEXT, years INTEGER, installs TEXT, buys TEXT, delivery_cities TEXT,
    verified INTEGER NOT NULL DEFAULT 0, docs_status TEXT NOT NULL DEFAULT 'pending', setup_by TEXT NOT NULL DEFAULT 'self', invited_by INTEGER,
    claimed INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  INSERT INTO businesses (role, name, phone, created_at) VALUES ('buyer', 'Old Buyer', '03110000000', '2026-01-01');
  CREATE TABLE requests (id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL, model_id INTEGER, category TEXT NOT NULL, description TEXT,
    qty INTEGER NOT NULL, city TEXT NOT NULL, needed_by TEXT, scope TEXT NOT NULL DEFAULT 'all', listing_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  INSERT INTO requests (buyer_id, category, qty, city, created_at, expires_at) VALUES (1, 'battery', 2, 'Lahore', '2026-01-01', '2026-01-03');
  CREATE TABLE request_targets (request_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
    sent_at TEXT NOT NULL, PRIMARY KEY (request_id, supplier_id));
`);
legacy.close();
process.env.DATA_DIR = dir;
const db = await import('../../src/db.js');
await db.init();

test('an older database is upgraded in place without losing data', () => {
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
  assert.ok(cols('requests').includes('bidding'));
  assert.ok(cols('request_targets').includes('in_stock'));
  assert.ok(cols('request_targets').includes('stock_price'));
  for (const t of ['bids', 'conversations', 'chat_messages', 'chat_reads']) assert.ok(cols(t).length > 0, `${t} exists`);
  assert.equal(db.get('SELECT bidding FROM requests WHERE id = 1').bidding, 'open');
  assert.equal(db.get('SELECT name FROM businesses WHERE id = 1').name, 'Old Buyer');
});

test('seeding does not run on a database that already has businesses', () => {
  assert.equal(db.get('SELECT COUNT(*) n FROM businesses').n, 1);
});

test('init can run twice safely', async () => {
  await db.init();
  assert.ok(db.all('PRAGMA table_info(requests)').filter((c) => c.name === 'bidding').length === 1);
});

test('query helpers turn undefined into NULL and booleans into 0 or 1', () => {
  db.run('CREATE TABLE IF NOT EXISTS t (a, b)');
  db.run('INSERT INTO t (a, b) VALUES (?, ?)', undefined, true);
  const row = db.get('SELECT a, b FROM t');
  assert.equal(row.a, null);
  assert.equal(row.b, 1);
});

test('tx commits on success and rolls back on error', () => {
  db.run('CREATE TABLE IF NOT EXISTS t2 (v)');
  db.tx(() => db.run('INSERT INTO t2 (v) VALUES (1)'));
  assert.throws(() => db.tx(() => { db.run('INSERT INTO t2 (v) VALUES (2)'); throw new Error('boom'); }), /boom/);
  assert.deepEqual(db.all('SELECT v FROM t2').map((r) => r.v), [1]);
});

test('the conversation index keeps one general chat per buyer and supplier pair', () => {
  db.run("INSERT INTO businesses (id, role, name, phone, created_at) VALUES (2, 'supplier', 'Old Supplier', '03110000001', 'x')");
  db.run("INSERT INTO conversations (buyer_id, supplier_id, request_id, created_at, last_at) VALUES (1, 2, NULL, 'x', 'x')");
  assert.throws(() => db.run("INSERT INTO conversations (buyer_id, supplier_id, request_id, created_at, last_at) VALUES (1, 2, NULL, 'x', 'x')"), /UNIQUE/);
  db.run("INSERT INTO conversations (buyer_id, supplier_id, request_id, created_at, last_at) VALUES (1, 2, 1, 'x', 'x')");
});
