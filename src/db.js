// Database layer: Node's built-in SQLite, schema, small query helpers.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from './clock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const all = (sql, ...p) => db.prepare(sql).all(...clean(p));
export const get = (sql, ...p) => db.prepare(sql).get(...clean(p));
export const run = (sql, ...p) => db.prepare(sql).run(...clean(p));
export const now = () => nowIso();

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,               -- buyer | supplier | admin
  supplier_type TEXT,               -- importer | distributor | wholesaler
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  contact TEXT,
  phone TEXT UNIQUE NOT NULL,
  whatsapp TEXT,
  ntn TEXT,
  years INTEGER,
  installs TEXT,
  buys TEXT,
  delivery_cities TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  docs_status TEXT NOT NULL DEFAULT 'pending',  -- pending | received | verified | failed
  setup_by TEXT NOT NULL DEFAULT 'self',        -- self | team | invite
  invited_by INTEGER,
  claimed INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',        -- active | suspended
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,           -- panel | inverter | battery | structure | cable | accessory
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  specs TEXT,
  unit TEXT NOT NULL DEFAULT 'unit',
  status TEXT NOT NULL DEFAULT 'approved',      -- approved | pending | rejected
  submitted_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES businesses(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  min_order INTEGER NOT NULL DEFAULT 1,
  token_pct INTEGER NOT NULL DEFAULT 20,
  lead_days INTEGER NOT NULL DEFAULT 2,
  visibility TEXT NOT NULL DEFAULT 'band',      -- band | exact
  source TEXT NOT NULL DEFAULT 'manual',        -- team | quote | manual
  visible INTEGER NOT NULL DEFAULT 1,
  price_updated_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (supplier_id, model_id)
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  price INTEGER NOT NULL,
  source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES businesses(id),
  model_id INTEGER REFERENCES models(id),
  category TEXT NOT NULL,
  description TEXT,
  qty INTEGER NOT NULL,
  city TEXT NOT NULL,
  needed_by TEXT,
  scope TEXT NOT NULL DEFAULT 'all',            -- all | partners | listing | invite
  listing_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',          -- open | ordered | expired | cancelled
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_targets (
  request_id INTEGER NOT NULL REFERENCES requests(id),
  supplier_id INTEGER NOT NULL REFERENCES businesses(id),
  status TEXT NOT NULL DEFAULT 'sent',          -- sent | quoted | passed
  sent_at TEXT NOT NULL,
  PRIMARY KEY (request_id, supplier_id)
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  supplier_id INTEGER NOT NULL REFERENCES businesses(id),
  model_id INTEGER REFERENCES models(id),
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  token_pct INTEGER NOT NULL DEFAULT 20,
  lead_days INTEGER NOT NULL DEFAULT 2,
  channel TEXT NOT NULL DEFAULT 'app',          -- app | whatsapp
  share INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'band',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | chosen | lost
  created_at TEXT NOT NULL,
  UNIQUE (request_id, supplier_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES businesses(id),
  supplier_id INTEGER NOT NULL REFERENCES businesses(id),
  model_id INTEGER REFERENCES models(id),
  listing_id INTEGER,
  quote_id INTEGER,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  token_pct INTEGER NOT NULL,
  address TEXT NOT NULL,
  needed_by TEXT,
  note TEXT,
  token_proof TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | accepted | declined | dispatched | delivered | cancelled
  decline_reason TEXT,
  disputed INTEGER NOT NULL DEFAULT 0,
  dispute_note TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  dispatched_at TEXT,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sender_id INTEGER REFERENCES businesses(id),
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  direction TEXT NOT NULL,                      -- out (to the business) | in (from the business)
  body TEXT NOT NULL,
  buttons TEXT,
  context TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES businesses(id),
  label TEXT,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  business_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  request_id INTEGER NOT NULL REFERENCES requests(id),
  supplier_id INTEGER NOT NULL REFERENCES businesses(id),
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES businesses(id),
  supplier_id INTEGER NOT NULL REFERENCES businesses(id),
  request_id INTEGER REFERENCES requests(id),
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique ON conversations(buyer_id, supplier_id, IFNULL(request_id, 0));
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER REFERENCES businesses(id),
  kind TEXT NOT NULL DEFAULT 'text',            -- text | bid | system
  body TEXT NOT NULL,
  attachment TEXT,
  attachment_name TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_reads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, business_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_bids_request ON bids(request_id);
CREATE INDEX IF NOT EXISTS idx_listings_model ON listings(model_id);
CREATE INDEX IF NOT EXISTS idx_targets_supplier ON request_targets(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_wa_business ON wa_messages(business_id);

-- Every alert to a business. The in-app list reads this table; WhatsApp is one delivery channel on top of it.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  event TEXT NOT NULL,
  grp TEXT NOT NULL,                            -- requests | bidding | orders | chat | shop | ratings | account
  priority TEXT NOT NULL,                       -- urgent | normal
  body TEXT NOT NULL,
  buttons TEXT,
  context TEXT,
  link TEXT,
  wa_status TEXT NOT NULL,                      -- sent | queued | held | off | capped | batched
  send_after TEXT,
  sent_at TEXT,
  wa_message_id INTEGER,
  read_at TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_business ON notifications(business_id, id);
CREATE INDEX IF NOT EXISTS idx_notif_pending ON notifications(wa_status, send_after);
CREATE TABLE IF NOT EXISTS notify_prefs (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id),
  wa_requests INTEGER NOT NULL DEFAULT 1,
  wa_bidding INTEGER NOT NULL DEFAULT 1,
  wa_chat INTEGER NOT NULL DEFAULT 1,
  wa_shop INTEGER NOT NULL DEFAULT 1,
  wa_ratings INTEGER NOT NULL DEFAULT 1,
  quiet_start INTEGER,                          -- hour 0-23 in Pakistan time; NULL with quiet_end NULL = no quiet hours
  quiet_end INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  rater_id INTEGER NOT NULL REFERENCES businesses(id),
  ratee_id INTEGER NOT NULL REFERENCES businesses(id),
  rater_role TEXT NOT NULL,                     -- buyer | supplier
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags TEXT,
  comment TEXT,
  reply TEXT,
  reply_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,            -- comment hidden by the Kainat team; the stars still count
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revealed_at TEXT,
  UNIQUE (order_id, rater_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON ratings(ratee_id);
-- Small key/value store for scheduled jobs (for example, the day the morning price check last ran).
CREATE TABLE IF NOT EXISTS job_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export async function init() {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after the first release: add them to databases created earlier.
  const addColumn = (table, col, ddl) => {
    if (!all(`PRAGMA table_info(${table})`).some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addColumn('requests', 'bidding', "TEXT NOT NULL DEFAULT 'open'");   // open: suppliers see the best bid | sealed: only their own
  addColumn('request_targets', 'in_stock', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('request_targets', 'stock_qty', 'INTEGER');
  addColumn('request_targets', 'stock_price', 'INTEGER');
  addColumn('request_targets', 'wave', 'INTEGER NOT NULL DEFAULT 1');
  // Matching waves: wave 1 goes out at once, wider waves only if too few bids arrive.
  addColumn('requests', 'wave', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('requests', 'next_wave_at', 'TEXT');
  addColumn('requests', 'closing_notice_at', 'TEXT');
  addColumn('orders', 'auto_delivered', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('orders', 'accept_reminded_at', 'TEXT');
  addColumn('orders', 'rating_reminded_at', 'TEXT');
  const count = get('SELECT COUNT(*) n FROM businesses').n;
  if (count === 0) {
    const { seed } = await import('./seed.js');
    seed();
  }
}
