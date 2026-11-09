// JSON API. Every route is declared with the role allowed to call it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, now, tx, UPLOAD_DIR } from './db.js';
import { nowMs, setClock, MIN, HOUR, DAY, pktHour, pktDate } from './clock.js';
import * as N from './notify.js';
import * as R from './ratings.js';
import * as SMS from './sms.js';
import { phoneIn, maskPhones } from '../public/js/phone.js';

class HttpError extends Error {
  constructor(status, message, extra = null) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

// ---------- phone numbers stay on Kainat ----------
// Anything the other side reads is checked for phone numbers and WhatsApp links. A number is refused (422, code
// "phone_number") so the screen can warn the sender; if they then choose "send without the number", it goes with
// the number replaced. Every attempt is recorded (never the number itself) and counts against a supplier's ranking.
export const contactAttempts = (bizId, days = 30) =>
  get('SELECT COUNT(*) n FROM contact_attempts WHERE business_id = ? AND sent_masked = 0 AND at > ?', bizId, new Date(nowMs() - days * DAY).toISOString()).n;
function guardContact(me, text, place, { mask = false, refId = null } = {}) {
  if (!text || !phoneIn(text)) return { text, masked: false };
  run('INSERT INTO contact_attempts (business_id, place, ref_id, sent_masked, at) VALUES (?,?,?,?,?)', me.id, place, refId, mask ? 1 : 0, now());
  if (!mask) fail(422, 'Phone numbers can’t be shared on Kainat.', { code: 'phone_number', attempts: contactAttempts(me.id), role: me.role });
  return { text: maskPhones(text), masked: true };
}
// Business details everyone can see: refused outright, there is nothing to "send without".
function guardProfile(me, fields) {
  if (!Object.values(fields).some((v) => v && phoneIn(String(v)))) return;
  if (me?.id) run('INSERT INTO contact_attempts (business_id, place, sent_masked, at) VALUES (?,?,?,?)', me.id, 'profile', 0, now());
  fail(400, 'Phone numbers can’t go in your business details. Your number is already on your account, and buyers and suppliers reach you through Kainat.');
}
const wantsMask = (body) => body.mask === true || body.mask === 1 || body.mask === '1';

// ---------- helpers ----------
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  if (d.startsWith('92') && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = '0' + d;
  return d;
}
const int = (v, def = null) => {
  if (v === undefined || v === null || typeof v === 'boolean') return def;
  // Number('') and Number('  ') are 0, so blank input must be caught before converting.
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return def;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? n : def;
};
const str = (v, max = 500) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const rs = (n) => 'Rs ' + Number(n).toLocaleString('en-PK');
const dayLabel = (d) => {
  if (!d) return 'no date';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const dealsText = (n) => `${n} completed deal${n === 1 ? "" : "s"}`;
const leadText = (d) => (d ? `delivery in ${d} day${d > 1 ? 's' : ''}` : 'same-day delivery');
const modelName = (m) => (m ? `${m.brand} ${m.name}` : null);
const isPartner = (buyerId, supplierId) =>
  get(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND supplier_id = ? AND status IN ('accepted','dispatched','delivered')`,
    buyerId, supplierId).n;
const deliveredCount = (bizId) =>
  get(`SELECT COUNT(*) n FROM orders WHERE (buyer_id = ? OR supplier_id = ?) AND status = 'delivered'`, bizId, bizId).n;
const recentCount = (bizId) =>
  get(`SELECT COUNT(*) n FROM orders WHERE (buyer_id = ? OR supplier_id = ?) AND status = 'delivered' AND delivered_at > ?`,
    bizId, bizId, new Date(nowMs() - 90 * 864e5).toISOString()).n;
const band = (price) => [Math.floor((price * 0.96) / 1000) * 1000, Math.ceil((price * 1.04) / 1000) * 1000];
const staleDays = (iso) => Math.floor((nowMs() - Date.parse(iso)) / 864e5);
const cityMatch = (s, city) => {
  if (!city) return true;
  const c = city.trim().toLowerCase();
  return (s.city || '').toLowerCase() === c || (s.delivery_cities || '').toLowerCase().split(',').map((x) => x.trim()).includes(c);
};

// A direct WhatsApp reply from the Kainat bot to a message the business just sent (inside the conversation,
// so not a notification). Alerts go through notify() instead.
function waSend(businessId, body, buttons = null, context = null) {
  run('INSERT INTO wa_messages (business_id, direction, body, buttons, context, at) VALUES (?,?,?,?,?,?)',
    businessId, 'out', body, buttons ? JSON.stringify(buttons) : null, context ? JSON.stringify(context) : null, now());
}
const notify = N.notify;

// ---------- uploads ----------
// What a file really is, from its first bytes. The declared type is not trusted: a script renamed to .png is refused.
export function sniffType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  return null;
}
// Decodes a data: URL and checks size and real file type. Returns { buf, ext } or fails with a clear message.
function readUpload(dataUrl, what) {
  const m = /^data:(image\/(png|jpeg|jpg|webp)|application\/pdf);base64,(.+)$/s.exec(dataUrl);
  if (!m) fail(400, `${what} must be an image (PNG, JPG, WebP) or a PDF`);
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 6 * 1024 * 1024) fail(400, `${what} is larger than 6 MB`);
  const declared = m[1] === 'application/pdf' ? 'pdf' : m[2] === 'jpeg' ? 'jpg' : m[2];
  const real = sniffType(buf);
  if (!real) fail(400, `${what} is not a real image or PDF. Take a new screenshot and try again.`);
  if (real !== declared && !(declared === 'jpg' && real === 'jpg')) fail(400, `${what} is a ${real.toUpperCase()} file named as ${declared.toUpperCase()}. Send the original file.`);
  return { buf, ext: real };
}
function saveUpload(prefix, dataUrl) {
  if (!dataUrl) return null;
  const { buf, ext } = readUpload(dataUrl, 'Attachment');
  const file = `${prefix}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return file;
}
function sendFile(res, file) {
  const full = path.join(UPLOAD_DIR, path.basename(file));
  if (!fs.existsSync(full)) fail(404, 'File missing');
  const ext = path.extname(full).slice(1);
  res.writeHead(200, { 'Content-Type': ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Cache-Control': 'private, no-store' });
  res.end(fs.readFileSync(full));
}

// ---------- chat ----------
function convFor(buyerId, supplierId, requestId = null) {
  let c = get('SELECT * FROM conversations WHERE buyer_id = ? AND supplier_id = ? AND IFNULL(request_id, 0) = ?', buyerId, supplierId, requestId || 0);
  if (!c) {
    const t = now();
    const id = Number(run('INSERT INTO conversations (buyer_id, supplier_id, request_id, created_at, last_at) VALUES (?,?,?,?,?)',
      buyerId, supplierId, requestId || null, t, t).lastInsertRowid);
    c = get('SELECT * FROM conversations WHERE id = ?', id);
  }
  return c;
}
function markRead(convId, bizId) {
  const last = get('SELECT MAX(id) m FROM chat_messages WHERE conversation_id = ?', convId).m || 0;
  run(`INSERT INTO chat_reads (conversation_id, business_id, last_read_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, business_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`, convId, bizId, last);
}
function unreadFor(convId, bizId) {
  const r = get('SELECT last_read_id FROM chat_reads WHERE conversation_id = ? AND business_id = ?', convId, bizId);
  return get('SELECT COUNT(*) n FROM chat_messages WHERE conversation_id = ? AND id > ? AND IFNULL(sender_id, 0) <> ?', convId, r?.last_read_id || 0, bizId).n;
}
function postChat(conv, sender, kind, body, attachment = null, attachmentName = null) {
  const t = now();
  const id = Number(run('INSERT INTO chat_messages (conversation_id, sender_id, kind, body, attachment, attachment_name, at) VALUES (?,?,?,?,?,?,?)',
    conv.id, sender?.id || null, kind, body, attachment, attachmentName, t).lastInsertRowid);
  run('UPDATE conversations SET last_at = ? WHERE id = ?', t, conv.id);
  if (sender) {
    markRead(conv.id, sender.id);
    const other = sender.id === conv.buyer_id ? conv.supplier_id : conv.buyer_id;
    // One WhatsApp nudge per batch of unread messages, so a busy chat does not flood WhatsApp.
    if (kind === 'text' && unreadFor(conv.id, other) === 1) {
      notify(other, 'chat_message', { body: `New message from ${sender.name} on Kainat: ${body ? body.slice(0, 140) : 'sent an attachment'}`,
        buttons: ['Open chat'], context: { type: 'chat', conversation_id: conv.id } });
    }
  }
  return id;
}
function convView(c, me) {
  const otherId = me.id === c.buyer_id ? c.supplier_id : c.buyer_id;
  const r = c.request_id ? get('SELECT r.*, m.brand, m.name FROM requests r LEFT JOIN models m ON m.id = r.model_id WHERE r.id = ?', c.request_id) : null;
  const last = get('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', c.id);
  return {
    id: c.id, request_id: c.request_id, last_at: c.last_at, buyer_id: c.buyer_id, supplier_id: c.supplier_id,
    other: publicBiz(get('SELECT * FROM businesses WHERE id = ?', otherId), me),
    request: r ? { id: r.id, status: r.status, qty: r.qty, what: r.model_id ? `${r.brand} ${r.name}` : r.description || r.category } : null,
    last: last ? { body: last.body || (last.attachment ? 'Attachment' : ''), kind: last.kind, at: last.at, mine: last.sender_id === me.id } : null,
    unread: unreadFor(c.id, me.id),
  };
}
function mustConv(id, me) {
  const c = get('SELECT * FROM conversations WHERE id = ?', int(id));
  if (!c) fail(404, 'Chat not found');
  if (!me.is_admin && c.buyer_id !== me.id && c.supplier_id !== me.id) fail(403, 'Not your chat');
  return c;
}

// ---------- bidding ----------
function bidBoard(r, viewer) {
  const quotes = all("SELECT supplier_id, price FROM quotes WHERE request_id = ? AND status IN ('active','chosen') ORDER BY price", r.id);
  const out = { count: quotes.length, mode: r.bidding };
  const mine = quotes.findIndex((q) => q.supplier_id === viewer.id);
  if (mine >= 0) { out.my_rank = mine + 1; out.my_price = quotes[mine].price; }
  if (r.bidding === 'open' && quotes.length) out.lowest = quotes[0].price;
  return out;
}

function publicBiz(b, viewer) {
  if (!b) return null;
  const out = {
    id: b.id, role: b.role, supplier_type: b.supplier_type, name: b.name, city: b.city, contact: b.contact,
    verified: !!b.verified, docs_status: b.docs_status, setup_by: b.setup_by, created_at: b.created_at,
    years: b.years, delivery_cities: b.delivery_cities, status: b.status,
    deals: deliveredCount(b.id), deals_90d: recentCount(b.id),
  };
  if (viewer && viewer.id && viewer.id !== b.id) {
    out.with_you = viewer.role === 'buyer' ? isPartner(viewer.id, b.id) : isPartner(b.id, viewer.id);
  }
  // Contact details only for the business itself, admins, and the other side of an active or past deal.
  const canContact = viewer && (viewer.is_admin || viewer.id === b.id || out.with_you > 0 ||
    get(`SELECT COUNT(*) n FROM orders WHERE ((buyer_id = ? AND supplier_id = ?) OR (buyer_id = ? AND supplier_id = ?)) AND status <> 'cancelled'`,
      viewer.id, b.id, b.id, viewer.id).n > 0);
  // Phone numbers are never shown to other businesses, not even after an order: contact stays on Kainat.
  // The business itself and the Kainat team still see it.
  if (canContact) Object.assign(out, { address: b.address ? maskPhones(b.address) : b.address, ntn: b.ntn });
  if (viewer && (viewer.is_admin || viewer.id === b.id)) Object.assign(out, { phone: b.phone, whatsapp: b.whatsapp });
  if (b.role === 'buyer' || b.role === 'supplier') {
    out.rating = R.summary(b.id);
    if (viewer?.id && viewer.id !== b.id) out.my_last_rating = R.lastGiven(viewer.id, b.id);
  }
  return out;
}

function priceView(listing, viewer) {
  const exact = listing.visibility === 'exact' || (viewer && (viewer.verified || viewer.is_admin || viewer.id === listing.supplier_id ||
    (viewer.role === 'buyer' && isPartner(viewer.id, listing.supplier_id) > 0)));
  if (exact) return { exact: true, price: listing.price };
  const [lo, hi] = band(listing.price);
  return { exact: false, low: lo, high: hi };
}

const requestWhat = (r) => {
  const m = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
  return `${m ? modelName(m) : r.description || r.category} × ${r.qty}`;
};

// Close requests past their 48 hours and tell the buyer. Called before reading requests, and by the scheduler.
function expireRequests() {
  const due = all("SELECT * FROM requests WHERE status = 'open' AND expires_at < ?", now());
  for (const r of due) {
    run("UPDATE requests SET status = 'expired', next_wave_at = NULL WHERE id = ? AND status = 'open'", r.id);
    const bids = get("SELECT COUNT(*) n FROM quotes WHERE request_id = ? AND status = 'active'", r.id).n;
    notify(r.buyer_id, 'request_expired', {
      body: bids
        ? `Your request for ${requestWhat(r)} closed after 48 hours with ${bids} bid${bids === 1 ? '' : 's'} and no order. Post it again if you still need it.`
        : `Your request for ${requestWhat(r)} closed after 48 hours with no bids. Post it again, or invite a supplier you know.`,
      buttons: ['Open request'], context: { type: 'request', request_id: r.id }, dedupe: `expired-${r.id}`,
    });
  }
}

// ---------- matching waves ----------
// Wave 1 goes out at once: suppliers with the exact model in stock, plus the WAVE1_SIZE best of the rest.
// After 30 minutes with fewer than 2 bids, wave 2 sends it to everyone else who matches. After 2 hours with
// no bids at all, the buyer is told and can widen it to other cities.
export const WAVE1_SIZE = 5;
export const WAVE2_AFTER = 30 * MIN;
export const NO_BIDS_AFTER = 2 * HOUR;

// Higher is better. Exact stock first, then past deals with this buyer, how often the supplier answers
// requests, fresh prices, and their rating.
function supplierScore(s, buyerId, inStock) {
  let score = inStock ? 100 : 0;
  score += Math.min(30, isPartner(buyerId, s.id) * 10);
  const since = new Date(nowMs() - 90 * DAY).toISOString();
  const sent = get('SELECT COUNT(*) n FROM request_targets WHERE supplier_id = ? AND sent_at > ?', s.id, since).n;
  const answered = get("SELECT COUNT(*) n FROM request_targets WHERE supplier_id = ? AND sent_at > ? AND status = 'quoted'", s.id, since).n;
  score += 30 * (sent ? answered / sent : 0.5);
  if (get('SELECT 1 x FROM listings WHERE supplier_id = ? AND visible = 1 AND confirmed_at > ?', s.id, new Date(nowMs() - 2 * DAY).toISOString())) score += 10;
  const rating = R.summary(s.id).avg;
  if (rating !== null) score += (rating - 3) * 5;
  // Trying to take buyers off Kainat by sharing numbers lowers where a supplier appears.
  score -= Math.min(30, contactAttempts(s.id) * 10);
  return score;
}

function rankForRequest(r, sups) {
  return sups.map((s) => {
    const inStock = !!stockMatch(r, s.id);
    return { s, inStock, score: supplierScore(s, r.buyer_id, inStock) };
  }).sort((a, b) => b.score - a.score || a.s.id - b.s.id);
}

function runWaves() {
  const due = all("SELECT * FROM requests WHERE status = 'open' AND next_wave_at IS NOT NULL AND next_wave_at <= ?", now());
  let sent = 0;
  for (const r of due) {
    const bids = get("SELECT COUNT(*) n FROM quotes WHERE request_id = ? AND status = 'active'", r.id).n;
    const buyer = get('SELECT * FROM businesses WHERE id = ?', r.buyer_id);
    if (r.wave === 1) {
      if (bids < 2) {
        const model = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
        const rest = matchSuppliers({ model, category: r.category, city: r.city, scope: 'all', buyerId: r.buyer_id });
        for (const { s } of rankForRequest(r, rest)) if (targetSupplier(r, buyer, s.id, 2)) sent++;
        run('UPDATE requests SET wave = 2, next_wave_at = ? WHERE id = ?', new Date(Date.parse(r.created_at) + NO_BIDS_AFTER).toISOString(), r.id);
      } else run('UPDATE requests SET next_wave_at = NULL WHERE id = ?', r.id);
    } else if (r.wave === 2) {
      if (bids === 0) {
        notify(r.buyer_id, 'request_no_bids', {
          body: `No bids yet on your request for ${requestWhat(r)} after 2 hours. Widen it to suppliers in other cities who deliver to ${r.city}, or invite a supplier you know.`,
          buttons: ['Widen search', 'Open request'], context: { type: 'request', request_id: r.id }, dedupe: `nobids-${r.id}`,
        });
        run('UPDATE requests SET wave = 3, next_wave_at = NULL WHERE id = ?', r.id);
      } else run('UPDATE requests SET next_wave_at = NULL WHERE id = ?', r.id);
    } else run('UPDATE requests SET next_wave_at = NULL WHERE id = ?', r.id);
  }
  return sent;
}

// Send a request to every supplier who sells the category, in any city.
function widenRequest(r, buyer) {
  if (r.status !== 'open') fail(409, 'Only open requests can be widened');
  const model = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
  const sups = matchSuppliers({ model, category: r.category, city: null, scope: 'all', buyerId: r.buyer_id });
  let n = 0;
  for (const { s } of rankForRequest(r, sups)) if (targetSupplier(r, buyer, s.id, 3)) n++;
  run("UPDATE requests SET scope = 'all', wave = 3, next_wave_at = NULL WHERE id = ?", r.id);
  return n;
}

function matchSuppliers({ model, category, city, scope, buyerId }) {
  let sups = all("SELECT * FROM businesses WHERE role = 'supplier' AND status = 'active'");
  if (scope === 'partners') return sups.filter((s) => isPartner(buyerId, s.id) > 0);
  sups = sups.filter((s) => cityMatch(s, city));
  return sups.filter((s) => {
    if (model) {
      const sameModel = get('SELECT COUNT(*) n FROM listings WHERE supplier_id = ? AND model_id = ?', s.id, model.id).n;
      const sameBrandCat = get(`SELECT COUNT(*) n FROM listings l JOIN models m ON m.id = l.model_id
        WHERE l.supplier_id = ? AND m.category = ? AND m.brand = ?`, s.id, model.category, model.brand).n;
      const sameCat = get(`SELECT COUNT(*) n FROM listings l JOIN models m ON m.id = l.model_id WHERE l.supplier_id = ? AND m.category = ?`,
        s.id, model.category).n;
      return sameModel || sameBrandCat || sameCat;
    }
    return get(`SELECT COUNT(*) n FROM listings l JOIN models m ON m.id = l.model_id WHERE l.supplier_id = ? AND m.category = ?`,
      s.id, category).n > 0;
  });
}

function requestText(r, buyer, supplierId) {
  const m = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
  const partner = isPartner(buyer.id, supplierId);
  const who = partner ? `traded with you ${partner}×` : `new buyer, ${dealsText(deliveredCount(buyer.id))}`;
  const what = m ? modelName(m) : `${r.description || r.category}`;
  const ex = m ? `${Math.round((get('SELECT AVG(price) p FROM listings WHERE model_id = ?', m.id).p || 100000) / 1000) * 1000} ${r.qty} 20` : `150000 ${r.qty} 20`;
  return `New request from ${buyer.name} (${who})\n${what} × ${r.qty}\n${r.city}, needed by ${dayLabel(r.needed_by)}\n\nReply with your price per unit, quantity and token %, for example: ${ex}`;
}

function stockMatch(r, supplierId) {
  if (!r.model_id) return null;
  const l = get('SELECT * FROM listings WHERE supplier_id = ? AND model_id = ? AND visible = 1 AND qty > 0', supplierId, r.model_id);
  return l || null;
}

function targetSupplier(r, buyer, supplierId, wave = 1) {
  const exists = get('SELECT 1 x FROM request_targets WHERE request_id = ? AND supplier_id = ?', r.id, supplierId);
  if (exists) return false;
  const l = stockMatch(r, supplierId);
  run('INSERT INTO request_targets (request_id, supplier_id, status, sent_at, in_stock, stock_qty, stock_price, wave) VALUES (?,?,?,?,?,?,?,?)',
    r.id, supplierId, 'sent', now(), l ? 1 : 0, l?.qty ?? null, l?.price ?? null, wave);
  if (l) {
    const m = get('SELECT * FROM models WHERE id = ?', r.model_id);
    const partner = isPartner(buyer.id, supplierId);
    notify(supplierId, 'request_match', {
      body: `In-stock match. ${buyer.name} (${partner ? `traded with you ${partner}×` : dealsText(deliveredCount(buyer.id))}) needs ${modelName(m)} × ${r.qty} in ${r.city}, by ${dayLabel(r.needed_by)}.\nYou have ${l.qty} in your shop at ${rs(l.price)}.\n\nBid now at your shop price, or reply with a lower price.`,
      buttons: [`Bid ${rs(l.price)}`, 'Bid lower', 'Not in stock'], context: { type: 'request', request_id: r.id, match: true } });
  } else {
    notify(supplierId, 'request_match', { body: requestText(r, buyer, supplierId), buttons: ['Send price', 'Not in stock'],
      context: { type: 'request', request_id: r.id } });
  }
  return true;
}

function instantBid(me, r) {
  const l = stockMatch(r, me.id);
  if (!l) fail(409, 'This model is not in stock in your shop. Send a quote instead.');
  return saveQuote(me, r, { price: l.price, qty: l.qty, token_pct: l.token_pct, lead_days: l.lead_days, share: 1, visibility: l.visibility, channel: 'app' });
}

// Send open requests that match a newly built or newly claimed shop.
function targetOpenRequests(supplierId) {
  expireRequests();
  const s = get('SELECT * FROM businesses WHERE id = ?', supplierId);
  const open = all("SELECT * FROM requests WHERE status = 'open' AND scope = 'all'");
  let n = 0;
  for (const r of open) {
    const model = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
    const matches = matchSuppliers({ model, category: r.category, city: r.city, scope: 'all', buyerId: r.buyer_id }).some((x) => x.id === s.id);
    if (matches) {
      const buyer = get('SELECT * FROM businesses WHERE id = ?', r.buyer_id);
      if (targetSupplier(r, buyer, s.id)) n++;
    }
  }
  return n;
}

function upsertListingFromQuote(q) {
  if (!q.model_id) return null;
  const existing = get('SELECT * FROM listings WHERE supplier_id = ? AND model_id = ?', q.supplier_id, q.model_id);
  const t = now();
  if (existing) {
    if (existing.price !== q.price) {
      run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', existing.id, q.price, 'quote', t);
    }
    run(`UPDATE listings SET price = ?, qty = ?, token_pct = ?, lead_days = ?, visibility = ?, visible = 1,
      price_updated_at = CASE WHEN price <> ? THEN ? ELSE price_updated_at END, confirmed_at = ? WHERE id = ?`,
      q.price, q.qty, q.token_pct, q.lead_days, q.visibility, q.price, t, t, existing.id);
    return existing.id;
  }
  const id = Number(run(`INSERT INTO listings (supplier_id, model_id, price, qty, min_order, token_pct, lead_days, visibility, source, visible,
    price_updated_at, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    q.supplier_id, q.model_id, q.price, q.qty, 1, q.token_pct, q.lead_days, q.visibility, 'quote', 1, t, t, t).lastInsertRowid);
  run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', id, q.price, 'quote', t);
  return id;
}

function saveQuote(me, r, b) {
  const target = get('SELECT * FROM request_targets WHERE request_id = ? AND supplier_id = ?', r.id, me.id);
  if (!target) fail(403, 'This request was not sent to you');
  if (r.status !== 'open') fail(409, 'This request is no longer open');
  const price = int(b.price);
  const qty = int(b.qty, r.qty);
  if (!price || price <= 0) fail(400, 'Enter a price per unit');
  if (!qty || qty <= 0) fail(400, 'Enter the quantity you have');
  const model_id = r.model_id || int(b.model_id);
  const token_pct = Math.min(100, Math.max(0, int(b.token_pct, 20)));
  const lead_days = Math.max(0, int(b.lead_days, 2));
  const visibility = b.visibility === 'exact' ? 'exact' : 'band';
  const share = b.share === false || b.share === 0 || b.share === '0' ? 0 : 1;
  const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'app';
  const note = guardContact(me, str(b.note), 'quote', { mask: wantsMask(b), refId: r.id }).text;
  const t = now();
  const existing = get('SELECT id, price FROM quotes WHERE request_id = ? AND supplier_id = ?', r.id, me.id);
  const prevLowest = get("SELECT MIN(price) p, supplier_id s FROM quotes WHERE request_id = ? AND supplier_id <> ? AND status = 'active'", r.id, me.id);
  let id;
  if (existing) {
    run(`UPDATE quotes SET model_id = ?, price = ?, qty = ?, token_pct = ?, lead_days = ?, channel = ?, share = ?, visibility = ?,
      note = ?, status = 'active', created_at = ? WHERE id = ?`, model_id, price, qty, token_pct, lead_days, channel, share, visibility,
      note, t, existing.id);
    id = existing.id;
  } else {
    id = Number(run(`INSERT INTO quotes (request_id, supplier_id, model_id, price, qty, token_pct, lead_days, channel, share, visibility,
      note, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.id, me.id, model_id, price, qty, token_pct, lead_days, channel,
      share, visibility, note, 'active', t).lastInsertRowid);
  }
  run("UPDATE request_targets SET status = 'quoted' WHERE request_id = ? AND supplier_id = ?", r.id, me.id);
  const q = get('SELECT * FROM quotes WHERE id = ?', id);
  if (share && channel === 'app') upsertListingFromQuote(q);
  run('INSERT INTO bids (quote_id, request_id, supplier_id, price, qty, at) VALUES (?,?,?,?,?,?)', id, r.id, me.id, price, qty, t);
  const m = model_id ? get('SELECT * FROM models WHERE id = ?', model_id) : null;
  const what = m ? modelName(m) : r.description || r.category;
  const revised = existing && existing.price !== price;
  // The bid also lands in the buyer and supplier's chat for this request, so the negotiation stays in one place.
  const conv = convFor(r.buyer_id, me.id, r.id);
  postChat(conv, me, 'bid', `${revised ? 'Revised bid' : 'Bid'}: ${rs(price)} per ${m?.unit || 'unit'} for ${what}. ${qty} available, ${token_pct}% token, ${leadText(lead_days)}.`);
  // The first bid on a request is what the buyer is waiting for, so it goes out at once; later bids may be batched.
  const firstBid = !existing && !get('SELECT 1 x FROM quotes WHERE request_id = ? AND id <> ?', r.id, id);
  notify(r.buyer_id, revised ? 'bid_revised' : firstBid ? 'bid_first' : 'bid_new', {
    body: `${revised ? 'Revised bid' : 'New bid'} from ${me.name} on your request (${what} × ${r.qty}): ${rs(price)} per ${m?.unit || 'unit'}, ${qty} available, ${token_pct}% token, ${leadText(lead_days)}.`,
    buttons: ['See bids'], context: { type: 'quotes', request_id: r.id } });
  // Open bidding: tell the supplier who just lost the lowest spot.
  if (r.bidding === 'open' && prevLowest?.p && price < prevLowest.p) {
    const buyer = get('SELECT name FROM businesses WHERE id = ?', r.buyer_id);
    notify(prevLowest.s, 'outbid', {
      body: `You have been outbid on ${buyer.name}'s request for ${what} × ${r.qty}. The lowest bid is now ${rs(price)}; yours is ${rs(prevLowest.p)}.`,
      buttons: ['Lower my bid', 'Open request'], context: { type: 'request', request_id: r.id } });
  }
  return q;
}

function orderView(o, viewer) {
  const m = o.model_id ? get('SELECT * FROM models WHERE id = ?', o.model_id) : null;
  const buyer = get('SELECT * FROM businesses WHERE id = ?', o.buyer_id);
  const supplier = get('SELECT * FROM businesses WHERE id = ?', o.supplier_id);
  return {
    ...o, token_proof: !!o.token_proof, model: m, model_name: modelName(m),
    total: o.price * o.qty, token_amount: Math.round((o.price * o.qty * o.token_pct) / 100),
    buyer: publicBiz(buyer, viewer), supplier: publicBiz(supplier, viewer),
    messages: all(`SELECT m.*, b.name sender_name FROM messages m LEFT JOIN businesses b ON b.id = m.sender_id WHERE order_id = ? ORDER BY id`, o.id),
    rating: R.forOrder(o, viewer),
  };
}

// Mark an order delivered (by the buyer, or automatically 7 days after dispatch) and ask both sides to rate.
function markDelivered(o, { auto = false } = {}) {
  const t = now();
  run("UPDATE orders SET status = 'delivered', delivered_at = ?, dispatched_at = COALESCE(dispatched_at, ?), auto_delivered = ? WHERE id = ?",
    t, t, auto ? 1 : 0, o.id);
  const buyer = get('SELECT * FROM businesses WHERE id = ?', o.buyer_id);
  const supplier = get('SELECT * FROM businesses WHERE id = ?', o.supplier_id);
  if (auto) {
    for (const id of [o.buyer_id, o.supplier_id]) {
      notify(id, 'order_update', { body: `Order #${o.id} was marked delivered automatically, 7 days after dispatch. If it did not arrive, flag a problem on the order page.`,
        buttons: ['Open order'], context: { type: 'order', order_id: o.id } });
    }
  } else {
    notify(o.supplier_id, 'order_update', { body: `${buyer.name} confirmed delivery of order #${o.id}. It now counts in your trade history.`,
      buttons: ['Open order'], context: { type: 'order', order_id: o.id } });
  }
  for (const [who, other] of [[buyer, supplier], [supplier, buyer]]) {
    notify(who.id, 'rate_prompt', {
      body: `Rate your deal with ${other.name} (order #${o.id}). Your rating stays hidden until they rate too, or for 14 days.`,
      buttons: R.STAR_BUTTONS, context: { type: 'rate', order_id: o.id }, dedupe: `rate-${o.id}-${who.id}`,
    });
  }
}

function mustOrder(id, me) {
  const o = get('SELECT * FROM orders WHERE id = ?', int(id));
  if (!o) fail(404, 'Order not found');
  if (!me.is_admin && o.buyer_id !== me.id && o.supplier_id !== me.id) fail(403, 'Not your order');
  return o;
}

function saveProof(orderId, dataUrl) {
  if (!dataUrl) return null;
  const { buf, ext } = readUpload(dataUrl, 'Token proof');
  const file = `order-${orderId}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return file;
}

function createOrder(me, b) {
  const qty = int(b.qty);
  if (!qty || qty <= 0) fail(400, 'Enter a quantity');
  if (!str(b.address, 300)) fail(400, 'Enter a delivery address');
  // The supplier reads the address and note: no phone numbers (a site contact is reached through Kainat too).
  const address = guardContact(me, str(b.address, 300), 'order_note', { mask: wantsMask(b) }).text;
  const orderNote = guardContact(me, str(b.note, 500), 'order_note', { mask: wantsMask(b) }).text;
  let supplierId, modelId, price, token, listingId = null, quoteId = null;
  if (b.quote_id) {
    const q = get('SELECT * FROM quotes WHERE id = ?', int(b.quote_id));
    if (!q) fail(404, 'Quote not found');
    const r = get('SELECT * FROM requests WHERE id = ?', q.request_id);
    if (r.buyer_id !== me.id) fail(403, 'Not your request');
    if (r.status !== 'open') fail(409, 'This request already has an order or has expired');
    if (q.status !== 'active') fail(409, 'This quote is no longer available');
    if (qty > q.qty) fail(400, `The supplier quoted for ${q.qty} only`);
    supplierId = q.supplier_id; modelId = q.model_id; price = q.price; token = q.token_pct; quoteId = q.id;
    run("UPDATE quotes SET status = CASE WHEN id = ? THEN 'chosen' ELSE 'lost' END WHERE request_id = ?", q.id, r.id);
    run("UPDATE requests SET status = 'ordered' WHERE id = ?", r.id);
    // A quote the supplier chose to share becomes a listing once a buyer picks it (WhatsApp quotes wait for the supplier's tap).
  } else if (b.listing_id) {
    const l = get('SELECT * FROM listings WHERE id = ?', int(b.listing_id));
    if (!l || !l.visible) fail(404, 'This item is no longer listed');
    const s = get('SELECT * FROM businesses WHERE id = ?', l.supplier_id);
    if (s.status !== 'active') fail(409, 'This supplier is not active');
    // A buyer who only sees a price range must get a quote first; ordering would otherwise reveal the hidden price.
    if (!priceView(l, me).exact) fail(403, 'Ask this supplier for an exact price first');
    if (qty < l.min_order) fail(400, `Minimum order is ${l.min_order}`);
    if (qty > l.qty) fail(400, `Only ${l.qty} in stock`);
    supplierId = l.supplier_id; modelId = l.model_id; price = l.price; token = l.token_pct; listingId = l.id;
  } else fail(400, 'Pick a listing or a quote');

  const id = Number(run(`INSERT INTO orders (buyer_id, supplier_id, model_id, listing_id, quote_id, qty, price, token_pct, address, needed_by,
    note, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, me.id, supplierId, modelId, listingId, quoteId, qty, price, token,
    address, str(b.needed_by, 20), orderNote, 'pending', now()).lastInsertRowid);
  const proof = saveProof(id, b.token_proof);
  if (proof) run('UPDATE orders SET token_proof = ? WHERE id = ?', proof, id);
  if (b.save_address) {
    const exists = get('SELECT 1 x FROM addresses WHERE buyer_id = ? AND text = ?', me.id, address);
    if (!exists) run('INSERT INTO addresses (buyer_id, label, text) VALUES (?,?,?)', me.id, str(b.address_label, 60) || 'Saved', address);
  }
  const m = get('SELECT * FROM models WHERE id = ?', modelId);
  notify(supplierId, 'order_new', {
    body: `New order from ${me.name}: ${modelName(m)} × ${qty} at ${rs(price)}. Token ${token}% (${rs(Math.round(price * qty * token / 100))})${proof ? ', proof attached' : ', no proof attached yet'}. Delivery: ${address}.`,
    buttons: ['Accept', 'Decline'], context: { type: 'order', order_id: id } });
  return id;
}

function acceptOrder(o, me) {
  if (o.supplier_id !== me.id) fail(403, 'Only the supplier can accept');
  if (o.status !== 'pending') fail(409, `Order is already ${o.status}`);
  run("UPDATE orders SET status = 'accepted', accepted_at = ? WHERE id = ?", now(), o.id);
  run('UPDATE listings SET qty = MAX(0, qty - ?) WHERE supplier_id = ? AND model_id = ?', o.qty, o.supplier_id, o.model_id);
  notify(o.buyer_id, 'order_update', { body: `${me.name} accepted your order #${o.id}. They will mark it dispatched when it leaves.`,
    buttons: ['Open order'], context: { type: 'order', order_id: o.id } });
}
function declineOrder(o, me, reason) {
  if (o.supplier_id !== me.id) fail(403, 'Only the supplier can decline');
  if (o.status !== 'pending') fail(409, `Order is already ${o.status}`);
  // The buyer reads the reason: a phone number in it is hidden.
  const why = str(reason) ? maskPhones(str(reason)) : null;
  if (why && why !== str(reason)) run('INSERT INTO contact_attempts (business_id, place, ref_id, sent_masked, at) VALUES (?,?,?,?,?)', me.id, 'order_message', o.id, 0, now());
  run("UPDATE orders SET status = 'declined', decline_reason = ? WHERE id = ?", why || 'No reason given', o.id);
  const reopened = reopenRequestFor(o, { keepChosen: false });
  notify(o.buyer_id, 'order_update', { body: `${me.name} declined order #${o.id}: ${why || 'no reason given'}.${reopened ? ' Your request is open again for other bids.' : ''}`,
    buttons: ['Open order'], context: { type: 'order', order_id: o.id } });
}

// When an order placed from a bid falls through (declined or cancelled), give the request back to the buyer:
// open again if it has not expired, with the other bids active. A declined bid is dropped; a bid the buyer
// cancelled stays available, since the supplier did nothing wrong. Returns true if the request is open again.
function reopenRequestFor(o, { keepChosen }) {
  if (!o.quote_id) return false;
  const q = get('SELECT request_id FROM quotes WHERE id = ?', o.quote_id);
  if (!q) return false;
  const t = now();
  run("UPDATE requests SET status = CASE WHEN expires_at > ? THEN 'open' ELSE 'expired' END WHERE id = ? AND status = 'ordered'", t, q.request_id);
  run("UPDATE quotes SET status = 'active' WHERE request_id = ? AND status IN ('lost','chosen')", q.request_id);
  if (!keepChosen) run("UPDATE quotes SET status = 'lost' WHERE id = ?", o.quote_id);
  return get('SELECT status FROM requests WHERE id = ?', q.request_id).status === 'open';
}

// ---------- routing ----------
const routes = [];
const route = (method, pattern, role, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, role, fn });
};

const MAX_BODY = 10 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = Number(req.headers['content-length'] || 0) > MAX_BODY;
    const chunks = [];
    // Too large: stop keeping the data but read the upload to the end before answering 413. Replying while
    // the client is still sending makes the connection reset, and the browser would show a network error.
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request too large'));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};

// Sessions end after 30 days without use, and after 90 days whatever happens.
export const SESSION_IDLE_MS = 30 * DAY;
export const SESSION_MAX_MS = 90 * DAY;
function sessionFrom(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = get('SELECT * FROM sessions WHERE token = ?', m[1]);
  if (!s) return null;
  const t = nowMs();
  if (t - Date.parse(s.last_seen || s.created_at) > SESSION_IDLE_MS || t - Date.parse(s.created_at) > SESSION_MAX_MS) {
    run('DELETE FROM sessions WHERE token = ?', s.token);
    return null;
  }
  if (!s.last_seen || t - Date.parse(s.last_seen) > HOUR) run('UPDATE sessions SET last_seen = ? WHERE token = ?', now(), s.token);
  const biz = s.business_id ? get('SELECT * FROM businesses WHERE id = ?', s.business_id) : null;
  return { session: s, me: biz || { id: null, phone: s.phone, role: null } };
}

// HTTPS is detected from the connection, or from the proxy in front of the server when TRUST_PROXY=1.
const isHttps = (req) => !!req.socket?.encrypted || (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = isHttps(req) || process.env.COOKIE_SECURE === '1';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
const clientIp = (req) => (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';

export async function handleApi(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return json(res, 404, { error: 'Not found' });
  const m = url.pathname.match(r.re);
  const params = {};
  r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  try {
    const auth = sessionFrom(req);
    const me = auth?.me || null;
    if (r.role !== 'public') {
      if (!me) fail(401, 'Please sign in');
      if (r.role !== 'any' && !me.id) fail(403, 'Finish setting up your account first');
      if (me.id && me.status === 'suspended' && !me.is_admin) fail(403, 'This account is suspended. Contact the Kainat team.');
      if (r.role === 'buyer' && me.role !== 'buyer') fail(403, 'Buyers only');
      if (r.role === 'supplier' && me.role !== 'supplier') fail(403, 'Suppliers only');
      if (r.role === 'admin' && !me.is_admin) fail(403, 'Admins only');
    }
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const out = await r.fn({ req, res, params, body, query, me, session: auth?.session });
    if (!res.headersSent) json(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof HttpError || e instanceof R.RatingError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    json(res, 500, { error: 'Something went wrong on the server' });
  }
}

// ---------- auth & onboarding ----------
// Sign-in code limits. The defaults suit production; tests and the demo can raise them with these variables.
const limit = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : def; };
export const OTP_TTL_MS = 10 * MIN;
export const OTP_MAX_ATTEMPTS = 5;
const otpPerPhoneHour = () => limit('OTP_MAX_PER_HOUR', 6);
const otpPerIpHour = () => limit('OTP_MAX_PER_IP_HOUR', 30);
const otpGapSec = () => limit('OTP_MIN_GAP_SEC', 30);

route('GET', '/api/config', 'public', () => ({ demo: SMS.devCodes() }));

route('POST', '/api/auth/start', 'public', async ({ body, req }) => {
  const phone = normPhone(body.phone);
  if (!/^03\d{9}$/.test(phone)) fail(400, 'Enter a Pakistani mobile number like 0300 1234567');
  const channel = body.channel === 'sms' ? 'sms' : 'whatsapp';
  const ip = clientIp(req);
  const t = nowMs();
  const hourAgo = new Date(t - HOUR).toISOString();
  const last = get('SELECT MAX(at) at FROM otp_requests WHERE phone = ?', phone).at;
  if (last && t - Date.parse(last) < otpGapSec() * 1000) {
    fail(429, `Wait ${Math.ceil(otpGapSec() - (t - Date.parse(last)) / 1000)} seconds before asking for another code.`);
  }
  if (get('SELECT COUNT(*) n FROM otp_requests WHERE phone = ? AND at > ?', phone, hourAgo).n >= otpPerPhoneHour()) {
    const first = get('SELECT MIN(at) at FROM otp_requests WHERE phone = ? AND at > ?', phone, hourAgo).at;
    fail(429, `Too many codes for this number. Try again in ${Math.max(1, Math.ceil((Date.parse(first) + HOUR - t) / MIN))} minutes.`);
  }
  if (get('SELECT COUNT(*) n FROM otp_requests WHERE ip = ? AND at > ?', ip, hourAgo).n >= otpPerIpHour()) {
    fail(429, 'Too many codes requested from this network. Try again later.');
  }
  const code = String(crypto.randomInt(100000, 1000000));
  try {
    await SMS.sendCode(phone, code, channel);
  } catch (e) {
    if (e instanceof SMS.CodeDeliveryError) fail(503, e.message);
    throw e;
  }
  run('INSERT INTO otp_requests (phone, ip, at) VALUES (?,?,?)', phone, ip, now());
  run(`INSERT INTO otps (phone, code, at, attempts) VALUES (?,?,?,0)
    ON CONFLICT(phone) DO UPDATE SET code = excluded.code, at = excluded.at, attempts = 0`, phone, code, now());
  // Development only: there is no SMS gateway, so the screen shows the code. Never in production.
  return SMS.devCodes() ? { phone, channel, devCode: code } : { phone, channel };
});

route('POST', '/api/auth/verify', 'public', ({ body, req, res }) => {
  const phone = normPhone(body.phone);
  const otp = get('SELECT * FROM otps WHERE phone = ?', phone);
  if (!otp) fail(400, 'That code is not right. Ask for a new one.');
  if (nowMs() - Date.parse(otp.at) > OTP_TTL_MS) { run('DELETE FROM otps WHERE phone = ?', phone); fail(400, 'That code has expired. Ask for a new one.'); }
  if (!crypto.timingSafeEqual(Buffer.from(otp.code.padEnd(8)), Buffer.from(String(body.code || '').trim().slice(0, 8).padEnd(8)))) {
    const used = otp.attempts + 1;
    if (used >= OTP_MAX_ATTEMPTS) { run('DELETE FROM otps WHERE phone = ?', phone); fail(400, 'Too many wrong codes. Ask for a new one.'); }
    run('UPDATE otps SET attempts = ? WHERE phone = ?', used, phone);
    const left = OTP_MAX_ATTEMPTS - used;
    fail(400, `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }
  run('DELETE FROM otps WHERE phone = ?', phone);
  const biz = get('SELECT * FROM businesses WHERE phone = ?', phone);
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions (token, phone, business_id, created_at, last_seen) VALUES (?,?,?,?,?)', token, phone, biz?.id || null, now(), now());
  setSessionCookie(req, res, token, SESSION_IDLE_MS / 1000);
  return { ok: true };
});

route('POST', '/api/auth/logout', 'any', ({ session, req, res }) => {
  if (session) run('DELETE FROM sessions WHERE token = ?', session.token);
  setSessionCookie(req, res, '', 0);
  return { ok: true };
});

// Sign out everywhere: ends every session for this number, including on other phones.
route('POST', '/api/auth/logout-all', 'any', ({ session, req, res }) => {
  const n = Number(run('DELETE FROM sessions WHERE phone = ?', session.phone).changes);
  setSessionCookie(req, res, '', 0);
  return { ended: n };
});

route('GET', '/api/me', 'public', ({ me }) => {
  if (!me) return { me: null };
  if (!me.id) return { me: { phone: me.phone, role: null } };
  const counts = {};
  if (me.role === 'supplier') {
    expireRequests();
    counts.open_requests = get(`SELECT COUNT(*) n FROM request_targets t JOIN requests r ON r.id = t.request_id
      WHERE t.supplier_id = ? AND t.status = 'sent' AND r.status = 'open'`, me.id).n;
    counts.pending_orders = get("SELECT COUNT(*) n FROM orders WHERE supplier_id = ? AND status = 'pending'", me.id).n;
    counts.listings = get('SELECT COUNT(*) n FROM listings WHERE supplier_id = ?', me.id).n;
    counts.unconfirmed_today = get('SELECT COUNT(*) n FROM listings WHERE supplier_id = ? AND visible = 1 AND confirmed_at < ?',
      me.id, new Date(Date.parse(pktDate() + 'T00:00:00+05:00')).toISOString()).n;
  }
  if (me.role === 'buyer') {
    counts.new_quotes = get(`SELECT COUNT(*) n FROM quotes q JOIN requests r ON r.id = q.request_id WHERE r.buyer_id = ? AND r.status = 'open'
      AND q.status = 'active'`, me.id).n;
  }
  counts.whatsapp = get("SELECT COUNT(*) n FROM wa_messages WHERE business_id = ? AND direction = 'out'", me.id).n;
  counts.notifications = N.unreadCount(me.id);
  if (me.role === 'buyer' || me.role === 'supplier') {
    counts.to_rate = all(`SELECT o.id FROM orders o WHERE (o.buyer_id = ? OR o.supplier_id = ?) AND o.status = 'delivered' AND o.delivered_at > ?
      AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.order_id = o.id AND r.rater_id = ?)`, me.id, me.id, new Date(nowMs() - R.RATING_WINDOW_MS).toISOString(), me.id).length;
  }
  counts.unread_chats = all('SELECT id FROM conversations WHERE buyer_id = ? OR supplier_id = ?', me.id, me.id)
    .reduce((n, c) => n + (unreadFor(c.id, me.id) > 0 ? 1 : 0), 0);
  return { me: { ...publicBiz(me, me), phone: me.phone, whatsapp: me.whatsapp, address: me.address, ntn: me.ntn, installs: me.installs,
    buys: me.buys, claimed: !!me.claimed, is_admin: !!me.is_admin }, counts };
});

route('POST', '/api/onboard', 'any', ({ me, session, body }) => {
  if (me.id) fail(409, 'This number already has an account');
  const role = body.role === 'supplier' ? 'supplier' : body.role === 'buyer' ? 'buyer' : fail(400, 'Choose buyer or supplier');
  const name = str(body.name, 120);
  const city = str(body.city, 60);
  if (!name) fail(400, 'Enter your business name');
  if (!city) fail(400, 'Enter your city');
  guardProfile(null, { name, address: body.address, contact: body.contact, buys: body.buys, delivery_cities: body.delivery_cities });
  const id = Number(run(`INSERT INTO businesses (role, supplier_type, name, city, address, contact, phone, whatsapp, ntn, years, installs, buys,
    delivery_cities, verified, docs_status, setup_by, claimed, status, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    role, role === 'supplier' ? (['importer', 'distributor', 'wholesaler'].includes(body.supplier_type) ? body.supplier_type : 'wholesaler') : null,
    name, city, str(body.address, 300), str(body.contact, 80), me.phone, me.phone, str(body.ntn, 40), int(body.years), str(body.installs, 40),
    str(body.buys, 200), role === 'supplier' ? str(body.delivery_cities, 200) || city : null, 0,
    body.ntn ? 'received' : 'pending', 'self', 1, 'active', 0, now()).lastInsertRowid);
  run('UPDATE sessions SET business_id = ? WHERE token = ?', id, session.token);
  if (role === 'supplier') {
    notify(id, 'welcome', { body: `Welcome to Kainat, ${name}. Buyer requests for what you sell will arrive here. Reply with a price and it becomes a quote.` });
  }
  return { id };
});

route('POST', '/api/claim', 'supplier', ({ me }) => {
  if (me.claimed) return { ok: true };
  run('UPDATE businesses SET claimed = 1 WHERE id = ?', me.id);
  run('UPDATE listings SET confirmed_at = ? WHERE supplier_id = ?', now(), me.id);
  targetOpenRequests(me.id);
  return { ok: true };
});

route('PUT', '/api/me', 'user', ({ me, body }) => {
  const f = {
    name: str(body.name, 120) || me.name, city: str(body.city, 60) || me.city, address: str(body.address, 300), contact: str(body.contact, 80),
    ntn: str(body.ntn, 40), years: int(body.years), installs: str(body.installs, 40), buys: str(body.buys, 200),
    delivery_cities: str(body.delivery_cities, 200), supplier_type: ['importer', 'distributor', 'wholesaler'].includes(body.supplier_type) ? body.supplier_type : me.supplier_type,
  };
  guardProfile(me, { name: f.name, city: f.city, address: f.address, contact: f.contact, buys: f.buys, delivery_cities: f.delivery_cities });
  run(`UPDATE businesses SET name = ?, city = ?, address = ?, contact = ?, ntn = ?, years = ?, installs = ?, buys = ?, delivery_cities = ?,
    supplier_type = ?, docs_status = CASE WHEN docs_status = 'pending' AND ? IS NOT NULL THEN 'received' ELSE docs_status END WHERE id = ?`,
    f.name, f.city, f.address, f.contact, f.ntn, f.years, f.installs, f.buys, f.delivery_cities, f.supplier_type, f.ntn, me.id);
  return { ok: true };
});

// ---------- catalogue ----------
route('GET', '/api/catalog', 'user', ({ me, query }) => {
  const terms = String(query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let rows = all("SELECT * FROM models WHERE status = 'approved' OR submitted_by = ? ORDER BY category, brand, name", me.id);
  if (query.category) rows = rows.filter((m) => m.category === query.category);
  if (terms.length) rows = rows.filter((m) => terms.every((t) => `${m.brand} ${m.name} ${m.category} ${m.specs || ''}`.toLowerCase().includes(t)));
  return rows.slice(0, 50);
});

route('POST', '/api/models', 'user', ({ me, body }) => {
  const category = ['panel', 'inverter', 'battery', 'structure', 'cable', 'accessory'].includes(body.category) ? body.category : fail(400, 'Pick a category');
  const brand = str(body.brand, 60) || fail(400, 'Enter the brand');
  const name = str(body.name, 120) || fail(400, 'Enter the model name');
  const dup = get('SELECT * FROM models WHERE lower(brand) = lower(?) AND lower(name) = lower(?)', brand, name);
  if (dup) return dup;
  const id = Number(run('INSERT INTO models (category, brand, name, specs, unit, status, submitted_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    category, brand, name, str(body.specs, 200), category === 'panel' ? 'panel' : 'unit', me.is_admin ? 'approved' : 'pending', me.id, now()).lastInsertRowid);
  return get('SELECT * FROM models WHERE id = ?', id);
});

// ---------- buyer ----------
function offersFor(model, me, city) {
  const listings = all(`SELECT l.*, b.name sname FROM listings l JOIN businesses b ON b.id = l.supplier_id
    WHERE l.model_id = ? AND l.visible = 1 AND b.status = 'active' AND b.role = 'supplier'`, model.id);
  const out = [];
  for (const l of listings) {
    const s = get('SELECT * FROM businesses WHERE id = ?', l.supplier_id);
    if (city && !cityMatch(s, city)) continue;
    out.push({ kind: 'listing', id: l.id, supplier: publicBiz(s, me), ...priceView(l, me), qty: l.qty, min_order: l.min_order,
      token_pct: l.token_pct, lead_days: l.lead_days, confirmed_at: l.confirmed_at, stale_days: staleDays(l.confirmed_at), source: l.source });
  }
  if (me.role === 'buyer') {
    const quotes = all(`SELECT q.*, r.qty req_qty, r.id rid FROM quotes q JOIN requests r ON r.id = q.request_id
      WHERE r.buyer_id = ? AND q.model_id = ? AND r.status = 'open' AND q.status = 'active'`, me.id, model.id);
    for (const q of quotes) {
      const s = get('SELECT * FROM businesses WHERE id = ?', q.supplier_id);
      out.push({ kind: 'quote', id: q.id, request_id: q.rid, supplier: publicBiz(s, me), exact: true, price: q.price, qty: q.qty, min_order: 1,
        token_pct: q.token_pct, lead_days: q.lead_days, confirmed_at: q.created_at, stale_days: 0, channel: q.channel });
    }
  }
  const sortPrice = (o) => (o.exact ? o.price : (o.low + o.high) / 2);
  out.sort((a, b) => (a.stale_days > 3) - (b.stale_days > 3) || (b.qty > 0) - (a.qty > 0) || sortPrice(a) - sortPrice(b));
  return out;
}

route('GET', '/api/search', 'user', ({ me, query }) => {
  const terms = String(query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let models = all("SELECT * FROM models WHERE status IN ('approved','pending') ORDER BY category, brand, name");
  if (query.category) models = models.filter((m) => m.category === query.category);
  if (terms.length) models = models.filter((m) => terms.every((t) => `${m.brand} ${m.name} ${m.category} ${m.specs || ''}`.toLowerCase().includes(t)));
  const city = str(query.city);
  const results = [];
  for (const m of models) {
    let offers = offersFor(m, me, city).filter((o) => o.kind === 'listing');
    if (query.instock === '1') offers = offers.filter((o) => o.qty > 0);
    if (!offers.length && !terms.length) continue;
    const prices = offers.map((o) => (o.exact ? o.price : o.low));
    results.push({ model: m, suppliers: offers.length, from: prices.length ? Math.min(...prices) : null,
      from_exact: offers.some((o) => o.exact && o.price === Math.min(...prices)) });
  }
  results.sort((a, b) => b.suppliers - a.suppliers);
  return results.slice(0, 40);
});

route('GET', '/api/models/:id/offers', 'user', ({ me, params, query }) => {
  const m = get('SELECT * FROM models WHERE id = ?', int(params.id));
  if (!m) fail(404, 'Model not found');
  return { model: m, offers: offersFor(m, me, str(query.city)) };
});

route('GET', '/api/listings/:id', 'user', ({ me, params }) => {
  const l = get('SELECT * FROM listings WHERE id = ?', int(params.id));
  if (!l) fail(404, 'Listing not found');
  const s = get('SELECT * FROM businesses WHERE id = ?', l.supplier_id);
  return { ...l, ...priceView(l, me), price: priceView(l, me).exact ? l.price : undefined, model: get('SELECT * FROM models WHERE id = ?', l.model_id), supplier: publicBiz(s, me) };
});

route('GET', '/api/quotes/:id', 'buyer', ({ me, params }) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', int(params.id));
  if (!q) fail(404, 'Quote not found');
  const r = get('SELECT * FROM requests WHERE id = ?', q.request_id);
  if (r.buyer_id !== me.id) fail(403, 'Not your request');
  return { ...q, request: r, model: q.model_id ? get('SELECT * FROM models WHERE id = ?', q.model_id) : null,
    supplier: publicBiz(get('SELECT * FROM businesses WHERE id = ?', q.supplier_id), me) };
});

route('GET', '/api/suppliers/:id', 'user', ({ me, params }) => {
  const s = get("SELECT * FROM businesses WHERE id = ? AND role = 'supplier'", int(params.id));
  if (!s) fail(404, 'Supplier not found');
  const history = me.role === 'buyer'
    ? all(`SELECT o.id, o.qty, o.status, o.delivered_at, o.created_at, m.brand, m.name FROM orders o LEFT JOIN models m ON m.id = o.model_id
        WHERE o.buyer_id = ? AND o.supplier_id = ? ORDER BY o.id DESC LIMIT 20`, me.id, s.id) : [];
  const items = all(`SELECT l.*, m.brand, m.name, m.category, m.unit FROM listings l JOIN models m ON m.id = l.model_id
    WHERE l.supplier_id = ? AND l.visible = 1 ORDER BY m.category, m.brand`, s.id).map((l) => ({ ...l, ...priceView(l, me), price: priceView(l, me).exact ? l.price : undefined }));
  return { supplier: publicBiz(s, me), history, items, reviews: R.reviewsFor(s.id, 10) };
});

route('POST', '/api/requests', 'buyer', ({ me, body }) => {
  expireRequests();
  let model = null;
  let listing = null;
  if (body.listing_id) {
    listing = get('SELECT * FROM listings WHERE id = ?', int(body.listing_id));
    if (!listing) fail(404, 'Listing not found');
    model = get('SELECT * FROM models WHERE id = ?', listing.model_id);
  } else if (body.model_id) {
    model = get('SELECT * FROM models WHERE id = ?', int(body.model_id));
    if (!model) fail(404, 'Model not found');
  }
  const category = model?.category || (['panel', 'inverter', 'battery', 'structure', 'cable', 'accessory'].includes(body.category) ? body.category : null);
  if (!category) fail(400, 'Pick a model or a category');
  const description = guardContact(me, str(body.description, 200), 'request', { mask: wantsMask(body) }).text;
  if (!model && !description) fail(400, 'Describe what you need, for example "5 kWh lithium battery"');
  const qty = int(body.qty);
  if (!qty || qty <= 0) fail(400, 'Enter a quantity');
  const city = str(body.city, 60) || me.city;
  const scope = listing ? 'listing' : body.scope === 'partners' ? 'partners' : 'all';
  const bidding = body.bidding === 'sealed' ? 'sealed' : 'open';
  const t = now();
  return tx(() => {
    const id = Number(run(`INSERT INTO requests (buyer_id, model_id, category, description, qty, city, needed_by, scope, listing_id, status,
      created_at, expires_at, bidding) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, me.id, model?.id || null, category, description, qty, city,
      str(body.needed_by, 20), scope, listing?.id || null, 'open', t, new Date(nowMs() + 48 * 3600000).toISOString(), bidding).lastInsertRowid);
    const r = get('SELECT * FROM requests WHERE id = ?', id);
    let first;
    let later = 0;
    if (scope === 'all') {
      // Wave 1: everyone with the exact model in stock, plus the best few of the rest. The others wait 30 minutes.
      const ranked = rankForRequest(r, matchSuppliers({ model, category, city, scope, buyerId: me.id }));
      const stocked = ranked.filter((x) => x.inStock);
      const rest = ranked.filter((x) => !x.inStock);
      first = [...stocked, ...rest.slice(0, WAVE1_SIZE)].map((x) => x.s);
      later = rest.length - Math.min(rest.length, WAVE1_SIZE);
      run('UPDATE requests SET wave = 1, next_wave_at = ? WHERE id = ?', new Date(nowMs() + (later ? WAVE2_AFTER : NO_BIDS_AFTER)).toISOString(), id);
      if (!later) run('UPDATE requests SET wave = 2 WHERE id = ?', id);
    } else {
      first = listing ? [get('SELECT * FROM businesses WHERE id = ?', listing.supplier_id)] : matchSuppliers({ model, category, city, scope, buyerId: me.id });
      run('UPDATE requests SET wave = 2, next_wave_at = ? WHERE id = ?', new Date(nowMs() + NO_BIDS_AFTER).toISOString(), id);
    }
    const fresh = get('SELECT * FROM requests WHERE id = ?', id);
    for (const s of first) targetSupplier(fresh, me, s.id, 1);
    const in_stock = get('SELECT COUNT(*) n FROM request_targets WHERE request_id = ? AND in_stock = 1', id).n;
    return { id, sent_to: first.length, in_stock, later };
  });
});

route('GET', '/api/requests', 'user', ({ me }) => {
  expireRequests();
  if (me.role === 'buyer') {
    return all(`SELECT r.*, m.brand, m.name, m.unit,
        (SELECT COUNT(*) FROM quotes q WHERE q.request_id = r.id) quotes,
        (SELECT COUNT(*) FROM request_targets t WHERE t.request_id = r.id) sent_to,
        (SELECT MIN(price) FROM quotes q WHERE q.request_id = r.id) best
      FROM requests r LEFT JOIN models m ON m.id = r.model_id WHERE r.buyer_id = ? ORDER BY r.id DESC LIMIT 50`, me.id);
  }
  if (me.role === 'supplier') {
    const rows = all(`SELECT r.*, t.status target_status, t.sent_at, m.brand, m.name, m.unit, b.name buyer_name, b.id buyer_id,
        (SELECT COUNT(*) FROM quotes q WHERE q.request_id = r.id AND q.supplier_id <> ?) others_quoted
      FROM request_targets t JOIN requests r ON r.id = t.request_id LEFT JOIN models m ON m.id = r.model_id JOIN businesses b ON b.id = r.buyer_id
      WHERE t.supplier_id = ? ORDER BY r.id DESC LIMIT 60`, me.id, me.id);
    return rows.map((r) => ({ ...r, in_stock: get('SELECT in_stock, stock_qty, stock_price FROM request_targets WHERE request_id = ? AND supplier_id = ?', r.id, me.id),
      buyer: publicBiz(get('SELECT * FROM businesses WHERE id = ?', r.buyer_id), me), board: bidBoard(r, me),
      my_quote: get('SELECT * FROM quotes WHERE request_id = ? AND supplier_id = ?', r.id, me.id) || null }));
  }
  return [];
});

route('GET', '/api/requests/:id', 'user', ({ me, params }) => {
  expireRequests();
  const r = get('SELECT * FROM requests WHERE id = ?', int(params.id));
  if (!r) fail(404, 'Request not found');
  const model = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
  const buyer = get('SELECT * FROM businesses WHERE id = ?', r.buyer_id);
  if (me.role === 'buyer') {
    if (r.buyer_id !== me.id) fail(403, 'Not your request');
    const quotes = all('SELECT * FROM quotes WHERE request_id = ? ORDER BY price', r.id).map((q) => ({
      ...q, model: q.model_id ? get('SELECT * FROM models WHERE id = ?', q.model_id) : null,
      revisions: get('SELECT COUNT(DISTINCT price) n FROM bids WHERE quote_id = ?', q.id).n,
      first_price: get('SELECT price FROM bids WHERE quote_id = ? ORDER BY id LIMIT 1', q.id)?.price ?? q.price,
      conversation_id: get('SELECT id FROM conversations WHERE buyer_id = ? AND supplier_id = ? AND request_id = ?', me.id, q.supplier_id, r.id)?.id || null,
      supplier: publicBiz(get('SELECT * FROM businesses WHERE id = ?', q.supplier_id), me) }));
    const targets = all(`SELECT t.status, t.in_stock, t.stock_qty, b.id, b.name FROM request_targets t JOIN businesses b ON b.id = t.supplier_id WHERE t.request_id = ?`, r.id);
    // Suppliers that have the exact model in stock right now but have not bid yet: the buyer can order from their listing straight away.
    const in_stock = r.model_id ? all(`SELECT l.* FROM request_targets t JOIN listings l ON l.supplier_id = t.supplier_id AND l.model_id = ?
        WHERE t.request_id = ? AND l.visible = 1 AND l.qty > 0 AND t.supplier_id NOT IN (SELECT supplier_id FROM quotes WHERE request_id = ?)`, r.model_id, r.id, r.id)
      .map((l) => ({ id: l.id, ...priceView(l, me), qty: l.qty, min_order: l.min_order, token_pct: l.token_pct, lead_days: l.lead_days,
        supplier: publicBiz(get('SELECT * FROM businesses WHERE id = ?', l.supplier_id), me) })) : [];
    const order = get('SELECT id, status FROM orders WHERE quote_id IN (SELECT id FROM quotes WHERE request_id = ?) ORDER BY id DESC', r.id);
    return { request: r, model, quotes, targets, in_stock, order: order || null };
  }
  if (me.role === 'supplier') {
    const target = get('SELECT * FROM request_targets WHERE request_id = ? AND supplier_id = ?', r.id, me.id);
    if (!target) fail(403, 'This request was not sent to you');
    const mine = get('SELECT * FROM quotes WHERE request_id = ? AND supplier_id = ?', r.id, me.id);
    const myListing = model ? get('SELECT * FROM listings WHERE supplier_id = ? AND model_id = ?', me.id, model.id) : null;
    return { request: r, model, buyer: publicBiz(buyer, me), target, my_quote: mine || null, my_listing: myListing || null,
      board: bidBoard(r, me), bid_history: mine ? all('SELECT price, qty, at FROM bids WHERE quote_id = ? ORDER BY id DESC LIMIT 10', mine.id) : [],
      conversation_id: get('SELECT id FROM conversations WHERE buyer_id = ? AND supplier_id = ? AND request_id = ?', r.buyer_id, me.id, r.id)?.id || null,
      others_quoted: get('SELECT COUNT(*) n FROM quotes WHERE request_id = ? AND supplier_id <> ?', r.id, me.id).n };
  }
  if (me.is_admin) return { request: r, model, buyer: publicBiz(buyer, me) };
  fail(403, 'Not allowed');
});

route('POST', '/api/requests/:id/cancel', 'buyer', ({ me, params }) => {
  const r = get('SELECT * FROM requests WHERE id = ?', int(params.id));
  if (!r || r.buyer_id !== me.id) fail(404, 'Request not found');
  if (r.status !== 'open') fail(409, 'Only open requests can be cancelled');
  run("UPDATE requests SET status = 'cancelled', next_wave_at = NULL WHERE id = ?", r.id);
  return { ok: true };
});

route('POST', '/api/requests/:id/widen', 'buyer', ({ me, params }) => {
  expireRequests();
  const r = get('SELECT * FROM requests WHERE id = ?', int(params.id));
  if (!r || r.buyer_id !== me.id) fail(404, 'Request not found');
  return tx(() => ({ sent_to: widenRequest(r, me) }));
});

route('POST', '/api/requests/:id/quote', 'supplier', ({ me, params, body }) => {
  expireRequests();
  const r = get('SELECT * FROM requests WHERE id = ?', int(params.id));
  if (!r) fail(404, 'Request not found');
  return tx(() => saveQuote(me, r, { ...body, channel: 'app' }));
});

route('POST', '/api/requests/:id/pass', 'supplier', ({ me, params }) => {
  const t = get('SELECT * FROM request_targets WHERE request_id = ? AND supplier_id = ?', int(params.id), me.id);
  if (!t) fail(404, 'Request not found');
  run("UPDATE request_targets SET status = 'passed' WHERE request_id = ? AND supplier_id = ?", int(params.id), me.id);
  return { ok: true };
});

route('POST', '/api/requests/:id/instant-bid', 'supplier', ({ me, params }) => {
  expireRequests();
  const r = get('SELECT * FROM requests WHERE id = ?', int(params.id));
  if (!r) fail(404, 'Request not found');
  return tx(() => { const q = instantBid(me, r); return { quote: q, board: bidBoard(get('SELECT * FROM requests WHERE id = ?', r.id), me) }; });
});

route('GET', '/api/requests/:id/board', 'user', ({ me, params }) => {
  const r = get('SELECT * FROM requests WHERE id = ?', int(params.id));
  if (!r) fail(404, 'Request not found');
  if (me.role === 'supplier' && !get('SELECT 1 x FROM request_targets WHERE request_id = ? AND supplier_id = ?', r.id, me.id)) fail(403, 'Not sent to you');
  if (me.role === 'buyer' && r.buyer_id !== me.id) fail(403, 'Not your request');
  const latest = get('SELECT MAX(id) m FROM bids WHERE request_id = ?', r.id).m || 0;
  return { ...bidBoard(r, me), status: r.status, latest };
});

// ---------- chats ----------
route('POST', '/api/chats', 'user', ({ me, body }) => {
  const otherId = int(body.with_id);
  const other = get('SELECT * FROM businesses WHERE id = ?', otherId);
  if (!other || other.status !== 'active') fail(404, 'Business not found');
  let buyerId, supplierId;
  if (me.role === 'buyer' && other.role === 'supplier') { buyerId = me.id; supplierId = other.id; }
  else if (me.role === 'supplier' && other.role === 'buyer') { buyerId = other.id; supplierId = me.id; }
  else fail(400, 'Chats are between a buyer and a supplier');
  const requestId = int(body.request_id);
  if (requestId) {
    const r = get('SELECT * FROM requests WHERE id = ?', requestId);
    if (!r || r.buyer_id !== buyerId) fail(404, 'Request not found');
    if (!get('SELECT 1 x FROM request_targets WHERE request_id = ? AND supplier_id = ?', r.id, supplierId)) {
      if (me.role === 'supplier') fail(403, 'This request was not sent to you');
      targetSupplier(r, me, supplierId); // a buyer opening a chat about their request also sends it to that supplier
    }
  } else if (me.role === 'supplier') {
    // Suppliers can only start chats with buyers who contacted them or traded with them, to keep buyers free of cold pitches.
    const known = get(`SELECT (SELECT COUNT(*) FROM request_targets t JOIN requests r ON r.id = t.request_id WHERE t.supplier_id = ? AND r.buyer_id = ?)
      + (SELECT COUNT(*) FROM orders WHERE supplier_id = ? AND buyer_id = ?) n`, me.id, other.id, me.id, other.id).n;
    if (!known) fail(403, 'You can message buyers who sent you a request or ordered from you');
  }
  return tx(() => ({ id: convFor(buyerId, supplierId, requestId || null).id }));
});

route('GET', '/api/chats', 'user', ({ me }) => all('SELECT * FROM conversations WHERE buyer_id = ? OR supplier_id = ? ORDER BY last_at DESC LIMIT 100', me.id, me.id)
  .map((c) => convView(c, me)).filter((c) => c.last));

route('GET', '/api/chats/:id', 'user', ({ me, params, query }) => {
  const c = mustConv(params.id, me);
  const after = int(query.after, 0);
  const msgs = all(`SELECT m.id, m.sender_id, m.kind, m.body, m.attachment_name, m.attachment IS NOT NULL has_file, m.at, b.name sender_name
    FROM chat_messages m LEFT JOIN businesses b ON b.id = m.sender_id WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id LIMIT 300`, c.id, after);
  if (!me.is_admin) markRead(c.id, me.id);
  const view = convView(c, me);
  if (c.request_id) {
    const r = get('SELECT * FROM requests WHERE id = ?', c.request_id);
    view.quote = get('SELECT * FROM quotes WHERE request_id = ? AND supplier_id = ?', c.request_id, c.supplier_id) || null;
    view.board = bidBoard(r, me);
  }
  return { conversation: view, messages: msgs.map((m) => ({ ...m, has_file: !!m.has_file })) };
});

route('POST', '/api/chats/:id/messages', 'user', ({ me, params, body }) => {
  const c = mustConv(params.id, me);
  if (c.buyer_id !== me.id && c.supplier_id !== me.id) fail(403, 'Only the two businesses can write in this chat');
  const raw = str(body.body, 2000);
  if (!raw && !body.attachment) fail(400, 'Type a message or attach a file');
  const { text, masked } = guardContact(me, raw, 'chat', { mask: wantsMask(body), refId: c.id });
  return tx(() => {
    const id = postChat(c, me, 'text', text || '', null, null);
    if (body.attachment) {
      const file = saveUpload(`chat-${c.id}-${id}`, body.attachment);
      run('UPDATE chat_messages SET attachment = ?, attachment_name = ? WHERE id = ?', file, maskPhones(str(body.attachment_name, 120) || 'attachment'), id);
    }
    // Both sides see why part of the message is missing.
    if (masked) postChat(c, null, 'system', 'A phone number was removed from this message. Keep contact on Kainat so the order stays protected.');
    return { id, masked };
  });
});

route('GET', '/api/chats/:id/files/:msg', 'user', ({ me, params, res }) => {
  const c = mustConv(params.id, me);
  const m = get('SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?', int(params.msg), c.id);
  if (!m?.attachment) fail(404, 'No attachment');
  sendFile(res, m.attachment);
});

route('POST', '/api/invite-supplier', 'buyer', ({ me, body }) => {
  const phone = normPhone(body.phone);
  if (!/^03\d{9}$/.test(phone)) fail(400, 'Enter the supplier’s mobile number like 0300 1234567');
  const name = str(body.name, 120) || fail(400, 'Enter the supplier’s business name');
  return tx(() => {
    let s = get('SELECT * FROM businesses WHERE phone = ?', phone);
    if (s && s.role !== 'supplier') fail(409, 'That number belongs to a buyer account');
    if (!s) {
      const id = Number(run(`INSERT INTO businesses (role, supplier_type, name, city, phone, whatsapp, delivery_cities, setup_by, invited_by, claimed,
        status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 'supplier', 'wholesaler', name, str(body.city, 60) || me.city, phone, phone,
        str(body.city, 60) || me.city, 'invite', me.id, 0, 'active', now()).lastInsertRowid);
      s = get('SELECT * FROM businesses WHERE id = ?', id);
    }
    notify(s.id, 'invited', { body: `${me.name} has added you as their supplier on Kainat. You can answer their requests here on WhatsApp, no app needed.` });
    let targeted = false;
    if (body.request_id) {
      const r = get('SELECT * FROM requests WHERE id = ? AND buyer_id = ?', int(body.request_id), me.id);
      if (r && r.status === 'open') targeted = targetSupplier(r, me, s.id);
    }
    return { supplier_id: s.id, targeted };
  });
});

route('GET', '/api/addresses', 'buyer', ({ me }) => all('SELECT * FROM addresses WHERE buyer_id = ? ORDER BY id', me.id));

// ---------- orders ----------
route('POST', '/api/orders', 'buyer', ({ me, body }) => tx(() => ({ id: createOrder(me, body) })));

route('GET', '/api/orders', 'user', ({ me }) => {
  const rows = me.is_admin ? all('SELECT * FROM orders ORDER BY id DESC LIMIT 200')
    : all('SELECT * FROM orders WHERE buyer_id = ? OR supplier_id = ? ORDER BY id DESC LIMIT 100', me.id, me.id);
  return rows.map((o) => {
    const m = o.model_id ? get('SELECT * FROM models WHERE id = ?', o.model_id) : null;
    const other = get('SELECT id, name FROM businesses WHERE id = ?', o.buyer_id === me.id ? o.supplier_id : o.buyer_id);
    const rated = !!get('SELECT 1 x FROM ratings WHERE order_id = ? AND rater_id = ?', o.id, me.id);
    return { ...o, token_proof: !!o.token_proof, model_name: modelName(m), other_name: other?.name,
      buyer_name: get('SELECT name FROM businesses WHERE id = ?', o.buyer_id)?.name,
      supplier_name: get('SELECT name FROM businesses WHERE id = ?', o.supplier_id)?.name, total: o.price * o.qty,
      rated, can_rate: !me.is_admin && !rated && o.status === 'delivered' && Date.parse(o.delivered_at) + R.RATING_WINDOW_MS > nowMs() };
  });
});

route('GET', '/api/orders/:id', 'user', ({ me, params }) => orderView(mustOrder(params.id, me), me));

route('GET', '/api/orders/:id/proof', 'user', ({ me, params, res }) => {
  const o = mustOrder(params.id, me);
  if (!o.token_proof) fail(404, 'No proof uploaded');
  const file = path.join(UPLOAD_DIR, path.basename(o.token_proof));
  if (!fs.existsSync(file)) fail(404, 'File missing');
  const ext = path.extname(file).slice(1);
  res.writeHead(200, { 'Content-Type': ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Cache-Control': 'private, no-store' });
  res.end(fs.readFileSync(file));
});

route('POST', '/api/orders/:id/proof', 'buyer', ({ me, params, body }) => {
  const o = mustOrder(params.id, me);
  if (o.buyer_id !== me.id) fail(403, 'Only the buyer can upload proof');
  const file = saveProof(o.id, body.token_proof);
  run('UPDATE orders SET token_proof = ? WHERE id = ?', file, o.id);
  notify(o.supplier_id, 'order_update', { body: `${me.name} uploaded token money proof for order #${o.id}.`, buttons: ['Open order'],
    context: { type: 'order', order_id: o.id } });
  return { ok: true };
});

route('POST', '/api/orders/:id/accept', 'supplier', ({ me, params }) => tx(() => acceptOrder(mustOrder(params.id, me), me)));
route('POST', '/api/orders/:id/decline', 'supplier', ({ me, params, body }) => tx(() => declineOrder(mustOrder(params.id, me), me, body.reason)));

route('POST', '/api/orders/:id/dispatch', 'supplier', ({ me, params }) => {
  const o = mustOrder(params.id, me);
  if (o.supplier_id !== me.id) fail(403, 'Only the supplier can dispatch');
  if (o.status !== 'accepted') fail(409, 'Accept the order before dispatching');
  run("UPDATE orders SET status = 'dispatched', dispatched_at = ? WHERE id = ?", now(), o.id);
  notify(o.buyer_id, 'order_update', { body: `${me.name} dispatched order #${o.id}. Mark it delivered in the app when it arrives. If you don't, it counts as delivered after 7 days.`,
    buttons: ['Open order'], context: { type: 'order', order_id: o.id } });
});

route('POST', '/api/orders/:id/deliver', 'buyer', ({ me, params }) => {
  const o = mustOrder(params.id, me);
  if (o.buyer_id !== me.id) fail(403, 'Only the buyer can confirm delivery');
  if (!['accepted', 'dispatched'].includes(o.status)) fail(409, 'This order cannot be marked delivered yet');
  tx(() => markDelivered(o));
});

// ---------- ratings ----------
route('POST', '/api/orders/:id/rating', 'user', ({ me, params, body }) => {
  const o = mustOrder(params.id, me);
  return tx(() => { R.submit(o, me, body); return R.forOrder(get('SELECT * FROM orders WHERE id = ?', o.id), me); });
});

route('POST', '/api/ratings/:id/reply', 'user', ({ me, params, body }) => R.reply(int(params.id), me, body.reply));

route('GET', '/api/businesses/:id/reviews', 'user', ({ params }) => {
  const b = get("SELECT * FROM businesses WHERE id = ? AND role IN ('buyer','supplier')", int(params.id)) || fail(404, 'Business not found');
  return { summary: R.summary(b.id), reviews: R.reviewsFor(b.id, 30) };
});

route('POST', '/api/orders/:id/cancel', 'buyer', ({ me, params }) => {
  const o = mustOrder(params.id, me);
  if (o.buyer_id !== me.id) fail(403, 'Not your order');
  if (o.status !== 'pending') fail(409, 'Only orders the supplier has not accepted can be cancelled');
  tx(() => {
    run("UPDATE orders SET status = 'cancelled' WHERE id = ?", o.id);
    reopenRequestFor(o, { keepChosen: true });
    notify(o.supplier_id, 'order_update', { body: `${me.name} cancelled order #${o.id} before you accepted it.`, context: { type: 'order', order_id: o.id } });
  });
});

route('POST', '/api/orders/:id/flag', 'user', ({ me, params, body }) => {
  const o = mustOrder(params.id, me);
  const note = str(body.note, 500) || fail(400, 'Describe the problem');
  run('UPDATE orders SET disputed = 1, dispute_note = ? WHERE id = ?', note, o.id);
  // The Kainat team reads the full note; the order thread, which the other side reads, hides any number.
  run('INSERT INTO messages (order_id, sender_id, body, at) VALUES (?,?,?,?)', o.id, me.id, `Flagged a problem: ${maskPhones(note)}`, now());
});

route('POST', '/api/orders/:id/messages', 'user', ({ me, params, body }) => {
  const o = mustOrder(params.id, me);
  const raw = str(body.body, 1000) || fail(400, 'Type a message');
  const { text, masked } = me.is_admin ? { text: raw, masked: false } : guardContact(me, raw, 'order_message', { mask: wantsMask(body), refId: o.id });
  run('INSERT INTO messages (order_id, sender_id, body, at) VALUES (?,?,?,?)', o.id, me.id, text, now());
  if (masked) run('INSERT INTO messages (order_id, sender_id, body, at) VALUES (?,?,?,?)', o.id, null, 'Kainat: a phone number was removed from this message. Keep contact on Kainat so the order stays protected.', now());
  const other = o.buyer_id === me.id ? o.supplier_id : o.buyer_id;
  notify(other, 'order_message', { body: `Message from ${me.name} about order #${o.id}: ${text}`, buttons: ['Open order'],
    context: { type: 'order', order_id: o.id } });
});

// ---------- supplier shop ----------
route('GET', '/api/shop', 'supplier', ({ me }) => all(`SELECT l.*, m.brand, m.name, m.category, m.unit, m.status model_status FROM listings l
  JOIN models m ON m.id = l.model_id WHERE l.supplier_id = ? ORDER BY l.visible DESC, m.category, m.brand, m.name`, me.id)
  .map((l) => ({ ...l, stale_days: staleDays(l.confirmed_at), band: band(l.price) })));

route('POST', '/api/listings', 'supplier', ({ me, body }) => {
  const model = get('SELECT * FROM models WHERE id = ?', int(body.model_id));
  if (!model) fail(400, 'Pick a model');
  if (get('SELECT 1 x FROM listings WHERE supplier_id = ? AND model_id = ?', me.id, model.id)) fail(409, 'This model is already in your shop. Edit it instead.');
  const price = int(body.price);
  if (!price || price <= 0) fail(400, 'Enter a price');
  const t = now();
  const id = Number(run(`INSERT INTO listings (supplier_id, model_id, price, qty, min_order, token_pct, lead_days, visibility, source, visible,
    price_updated_at, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, me.id, model.id, price, Math.max(0, int(body.qty, 0)),
    Math.max(1, int(body.min_order, 1)), Math.min(100, Math.max(0, int(body.token_pct, 20))), Math.max(0, int(body.lead_days, 2)),
    body.visibility === 'exact' ? 'exact' : 'band', 'manual', 1, t, t, t).lastInsertRowid);
  run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', id, price, 'manual', t);
  return { id };
});

route('PUT', '/api/listings/:id', 'supplier', ({ me, params, body }) => {
  const l = get('SELECT * FROM listings WHERE id = ? AND supplier_id = ?', int(params.id), me.id);
  if (!l) fail(404, 'Listing not found');
  const price = int(body.price, l.price);
  if (price <= 0) fail(400, 'Enter a price');
  const t = now();
  if (price !== l.price) run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', l.id, price, 'edit', t);
  run(`UPDATE listings SET price = ?, qty = ?, min_order = ?, token_pct = ?, lead_days = ?, visibility = ?, visible = ?,
    price_updated_at = ?, confirmed_at = ? WHERE id = ?`, price, Math.max(0, int(body.qty, l.qty)), Math.max(1, int(body.min_order, l.min_order)),
    Math.min(100, Math.max(0, int(body.token_pct, l.token_pct))), Math.max(0, int(body.lead_days, l.lead_days)),
    body.visibility === 'exact' || body.visibility === 'band' ? body.visibility : l.visibility,
    body.visible === undefined ? l.visible : body.visible ? 1 : 0, price !== l.price ? t : l.price_updated_at, t, l.id);
  return { ok: true };
});

route('POST', '/api/listings/confirm-all', 'supplier', ({ me }) => {
  const r = run('UPDATE listings SET confirmed_at = ? WHERE supplier_id = ? AND visible = 1', now(), me.id);
  return { confirmed: Number(r.changes) };
});

route('GET', '/api/listings/:id/history', 'supplier', ({ me, params }) => {
  const l = get('SELECT * FROM listings WHERE id = ? AND supplier_id = ?', int(params.id), me.id);
  if (!l) fail(404, 'Listing not found');
  return all('SELECT * FROM price_history WHERE listing_id = ? ORDER BY id DESC LIMIT 30', l.id);
});

// ---------- simulated WhatsApp ----------
function parseQuoteText(text) {
  const t = text.toLowerCase().replace(/rs\.?/g, ' ');
  const nums = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(lakh|lac|k)?/g;
  let m;
  while ((m = re.exec(t))) {
    let n = Number(m[1].replace(/,/g, ''));
    if (m[2] === 'lakh' || m[2] === 'lac') n *= 100000;
    if (m[2] === 'k') n *= 1000;
    nums.push(Math.round(n));
  }
  if (!nums.length) return null;
  return { price: nums[0], qty: nums[1], token_pct: nums[2] };
}

function waReply(me, text, button, context) {
  const t = now();
  run('INSERT INTO wa_messages (business_id, direction, body, buttons, context, at) VALUES (?,?,?,?,?,?)', me.id, 'in', button || text, null,
    context ? JSON.stringify(context) : null, t);
  const ctx = context || {};

  if (button === 'Yes, same') {
    const r = run('UPDATE listings SET confirmed_at = ? WHERE supplier_id = ? AND visible = 1', now(), me.id);
    return waSend(me.id, `Done. ${Number(r.changes)} prices confirmed for today.`);
  }
  if (button === 'Change some') return waSend(me.id, 'Open My shop in the app to change prices. Everything else stays as it is.', ['Open my shop'], { type: 'shop' });
  if (button === 'Not in stock' && ctx.request_id) {
    run("UPDATE request_targets SET status = 'passed' WHERE request_id = ? AND supplier_id = ?", ctx.request_id, me.id);
    return waSend(me.id, 'Noted. We will not send reminders for this request.');
  }
  if (button && button.startsWith('Bid Rs') && ctx.request_id) {
    const r = get('SELECT * FROM requests WHERE id = ?', ctx.request_id);
    if (!r || r.status !== 'open') return waSend(me.id, 'That request has closed. You will get the next one here.');
    const q = instantBid(me, r);
    const b = bidBoard(r, me);
    return waSend(me.id, `Bid placed at ${rs(q.price)}.${b.mode === 'open' ? ` You are #${b.my_rank} of ${b.count}${b.my_rank > 1 ? `; the lowest bid is ${rs(b.lowest)}` : ''}.` : ''} Reply with a lower price at any time to revise it.`,
      ['Lower my bid'], { type: 'request', request_id: r.id });
  }
  if ((button === 'Send price' || button === 'Bid lower' || button === 'Lower my bid') && ctx.request_id) {
    return waSend(me.id, 'Type your price per unit, quantity and token %, for example: 305000 8 20', null, { type: 'await_price', request_id: ctx.request_id });
  }
  if ((button === 'Yes, add it' || button === 'Only this buyer') && ctx.quote_id) {
    const q = get('SELECT * FROM quotes WHERE id = ? AND supplier_id = ?', ctx.quote_id, me.id);
    if (!q) return waSend(me.id, 'That quote is no longer available.');
    if (button === 'Yes, add it') {
      run('UPDATE quotes SET share = 1 WHERE id = ?', q.id);
      upsertListingFromQuote({ ...q, share: 1 });
      return waSend(me.id, 'Added to your shop. Buyers in your city can now find it in search.');
    }
    run('UPDATE quotes SET share = 0 WHERE id = ?', q.id);
    return waSend(me.id, 'Okay, only this buyer sees that price.');
  }
  if ((button === 'Accept' || button === 'Decline') && ctx.order_id) {
    const o = get('SELECT * FROM orders WHERE id = ?', ctx.order_id);
    if (!o || o.supplier_id !== me.id) return waSend(me.id, 'That order was not found.');
    if (o.status !== 'pending') return waSend(me.id, `Order #${o.id} is already ${o.status}.`);
    if (button === 'Accept') { acceptOrder(o, me); return waSend(me.id, `Order #${o.id} accepted. Mark it dispatched in the app when it leaves.`); }
    return waSend(me.id, `Why are you declining order #${o.id}? Reply with a short reason.`, null, { type: 'await_decline', order_id: o.id });
  }
  // Rating from WhatsApp: the star tap sets the stars; tags and a comment can be added in the app.
  const star = /^([1-5]) ★$/.exec(button || '');
  if (star && ctx.order_id) {
    const o = get('SELECT * FROM orders WHERE id = ?', ctx.order_id);
    if (!o || (o.buyer_id !== me.id && o.supplier_id !== me.id)) return waSend(me.id, 'That order was not found.');
    let saved;
    try {
      saved = R.submit(o, me, { stars: Number(star[1]), starsOnly: true });
    } catch (e) {
      if (e instanceof R.RatingError) return waSend(me.id, e.message + '.');
      throw e;
    }
    return waSend(me.id, `Thanks, ${star[1]} ★ saved for order #${o.id}. ${saved.revealed_at ? 'You have both rated, so both ratings are now shown. See theirs in the app.' : 'It stays hidden until they rate too.'} Add details in the app if you like.`,
      ['Open order'], { type: 'order', order_id: o.id });
  }
  if (button === 'Widen search' && ctx.request_id) {
    const r = get('SELECT * FROM requests WHERE id = ? AND buyer_id = ?', ctx.request_id, me.id);
    if (!r || r.status !== 'open') return waSend(me.id, 'That request has closed.');
    const n = widenRequest(r, me);
    return waSend(me.id, n ? `Sent to ${n} more supplier${n === 1 ? '' : 's'} in other cities who sell this.` : 'No other suppliers sell this yet. The Kainat team will look for one.',
      ['Open request'], { type: 'request', request_id: r.id });
  }
  if (button) return waSend(me.id, 'Open the app to continue.');

  // Free text: decline reason, price reply, or help.
  const last = get(`SELECT * FROM wa_messages WHERE business_id = ? AND direction = 'out' AND context IS NOT NULL ORDER BY id DESC LIMIT 1`, me.id);
  const lastCtx = last ? JSON.parse(last.context) : {};
  if (lastCtx.type === 'await_decline') {
    const o = get('SELECT * FROM orders WHERE id = ?', lastCtx.order_id);
    if (o && o.status === 'pending') { declineOrder(o, me, text); return waSend(me.id, `Order #${o.id} declined. The buyer has been told.`); }
  }
  // A phone number sent here would otherwise be read as a price (0300 1234567 → Rs 3,001,234,567).
  if (phoneIn(text)) {
    run('INSERT INTO contact_attempts (business_id, place, sent_masked, at) VALUES (?,?,?,?)', me.id, 'whatsapp', 0, now());
    return waSend(me.id, 'Phone numbers can’t be shared with buyers on Kainat. When contact moves outside Kainat the risk goes with it, and it can harm your supplier profile. Reply with your price, quantity and token %, for example: 305000 8 20');
  }
  if (me.role === 'supplier') {
    const parsed = parseQuoteText(text);
    let requestId = lastCtx.request_id;
    if (!requestId) {
      const open = get(`SELECT r.id FROM request_targets t JOIN requests r ON r.id = t.request_id WHERE t.supplier_id = ? AND t.status = 'sent'
        AND r.status = 'open' ORDER BY t.sent_at DESC LIMIT 1`, me.id);
      requestId = open?.id;
    }
    if (parsed && requestId) {
      const r = get('SELECT * FROM requests WHERE id = ?', requestId);
      if (r && r.status === 'open') {
        const q = saveQuote(me, r, { price: parsed.price, qty: parsed.qty || r.qty, token_pct: parsed.token_pct ?? 20, lead_days: 2,
          share: 0, visibility: 'band', channel: 'whatsapp' });
        const buyer = get('SELECT name FROM businesses WHERE id = ?', r.buyer_id);
        const m = r.model_id ? get('SELECT * FROM models WHERE id = ?', r.model_id) : null;
        if (m) {
          return waSend(me.id, `Quote sent to ${buyer.name}: ${modelName(m)} at ${rs(q.price)}, ${q.qty} available, ${q.token_pct}% token.\n\nAlso show this price to other buyers in your shop?`,
            ['Yes, add it', 'Only this buyer'], { type: 'share', quote_id: q.id });
        }
        return waSend(me.id, `Quote sent to ${buyer.name}: ${rs(q.price)} per unit, ${q.qty} available, ${q.token_pct}% token.`);
      }
      return waSend(me.id, 'That request has closed. You will get the next one here.');
    }
  }
  return waSend(me.id, me.role === 'supplier'
    ? 'To quote, reply to a request with price, quantity and token %, for example: 305000 8 20'
    : 'Open the app to see your quotes and orders.');
}

route('GET', '/api/whatsapp', 'user', ({ me }) => all('SELECT * FROM wa_messages WHERE business_id = ? ORDER BY id DESC LIMIT 80', me.id)
  .reverse().map((m) => ({ ...m, buttons: m.buttons ? JSON.parse(m.buttons) : null, context: m.context ? JSON.parse(m.context) : null })));

route('POST', '/api/whatsapp', 'user', ({ me, body }) => {
  const text = str(body.text, 1000);
  const button = str(body.button, 60);
  if (!text && !button) fail(400, 'Type a message');
  tx(() => waReply(me, text, button, body.context || null));
  return { ok: true };
});

// ---------- admin ----------
route('GET', '/api/admin/overview', 'admin', () => {
  const weekAgo = new Date(nowMs() - 7 * 864e5).toISOString();
  const fresh = get('SELECT COUNT(*) n FROM listings WHERE visible = 1 AND confirmed_at > ?', weekAgo).n;
  const perModel = all('SELECT model_id, COUNT(DISTINCT supplier_id) n FROM listings WHERE visible = 1 GROUP BY model_id');
  const popular = perModel.filter((x) => x.n >= 3).length;
  const reqs = get('SELECT COUNT(*) n FROM requests WHERE created_at > ?', weekAgo).n;
  const accepted = get("SELECT COUNT(*) n FROM orders WHERE status IN ('accepted','dispatched','delivered')").n;
  const declined = get("SELECT COUNT(*) n FROM orders WHERE status = 'declined'").n;
  const delivered = get("SELECT COUNT(*) n FROM orders WHERE status = 'delivered'").n;
  const buyers = all("SELECT buyer_id, COUNT(*) n FROM orders WHERE status = 'delivered' GROUP BY buyer_id");
  const repeat = buyers.length ? Math.round((100 * buyers.filter((b) => b.n >= 2).length) / buyers.length) : 0;
  const gaps = all(`SELECT (julianday(MIN(q.created_at)) - julianday(r.created_at)) * 24 * 60 mins FROM requests r JOIN quotes q ON q.request_id = r.id
    GROUP BY r.id`).map((x) => x.mins).sort((a, b) => a - b);
  const median = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;
  return {
    metrics: [
      { label: 'Listings with price confirmed in the last 7 days', value: fresh, target: '100 or more' },
      { label: 'Models with 3 or more suppliers', value: popular, target: 'grow every week' },
      { label: 'Buyer requests in the last 7 days', value: reqs, target: '20 or more a week' },
      { label: 'Order acceptance rate', value: accepted + declined ? Math.round((100 * accepted) / (accepted + declined)) + '%' : 'n/a', target: '60% or higher' },
      { label: 'Deals delivered', value: delivered, target: '30 or more' },
      { label: 'Repeat buyers', value: repeat + '%', target: '50% of buyers with a deal' },
      { label: 'Median time from request to first quote', value: median === null ? 'n/a' : median < 120 ? `${median} min` : `${Math.round(median / 60)} h`, target: 'under 1 hour' },
    ],
    counts: {
      suppliers: get("SELECT COUNT(*) n FROM businesses WHERE role = 'supplier'").n,
      unclaimed: get("SELECT COUNT(*) n FROM businesses WHERE role = 'supplier' AND claimed = 0").n,
      buyers: get("SELECT COUNT(*) n FROM businesses WHERE role = 'buyer'").n,
      pending_models: get("SELECT COUNT(*) n FROM models WHERE status = 'pending'").n,
      disputes: get('SELECT COUNT(*) n FROM orders WHERE disputed = 1').n,
      low_ratings: R.lowCount(),
      number_attempts: get('SELECT COUNT(*) n FROM contact_attempts WHERE sent_masked = 0 AND at > ?', new Date(nowMs() - 30 * DAY).toISOString()).n,
      wa_waiting: get("SELECT COUNT(*) n FROM notifications WHERE wa_status IN ('queued','held')").n,
      docs_to_check: get("SELECT COUNT(*) n FROM businesses WHERE role = 'supplier' AND docs_status IN ('pending','received')").n,
      open_requests: get("SELECT COUNT(*) n FROM requests WHERE status = 'open'").n,
    },
  };
});

route('GET', '/api/admin/businesses', 'admin', ({ query }) => {
  let rows = all("SELECT * FROM businesses WHERE role <> 'admin' ORDER BY role DESC, name");
  if (query.role) rows = rows.filter((b) => b.role === query.role);
  return rows.map((b) => ({ ...b, deals: deliveredCount(b.id), listings: get('SELECT COUNT(*) n FROM listings WHERE supplier_id = ?', b.id).n,
    number_attempts: contactAttempts(b.id) }));
});

route('PUT', '/api/admin/businesses/:id', 'admin', ({ params, body }) => {
  const b = get('SELECT * FROM businesses WHERE id = ?', int(params.id));
  if (!b) fail(404, 'Business not found');
  run('UPDATE businesses SET verified = ?, docs_status = ?, status = ? WHERE id = ?',
    body.verified === undefined ? b.verified : body.verified ? 1 : 0,
    ['pending', 'received', 'verified', 'failed'].includes(body.docs_status) ? body.docs_status : b.docs_status,
    ['active', 'suspended'].includes(body.status) ? body.status : b.status, b.id);
  if (body.status === 'suspended') run('DELETE FROM sessions WHERE business_id = ?', b.id);
  return { ok: true };
});

route('POST', '/api/admin/suppliers', 'admin', ({ body }) => {
  const phone = normPhone(body.phone);
  if (!/^03\d{9}$/.test(phone)) fail(400, 'Enter the supplier’s mobile number like 0300 1234567');
  if (get('SELECT 1 x FROM businesses WHERE phone = ?', phone)) fail(409, 'That number already has an account');
  const name = str(body.name, 120) || fail(400, 'Enter the business name');
  const city = str(body.city, 60) || fail(400, 'Enter the city');
  const items = Array.isArray(body.items) ? body.items.filter((i) => int(i.model_id) && int(i.price)) : [];
  return tx(() => {
    const id = Number(run(`INSERT INTO businesses (role, supplier_type, name, city, address, contact, phone, whatsapp, ntn, years, delivery_cities,
      verified, docs_status, setup_by, claimed, status, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'supplier', ['importer', 'distributor', 'wholesaler'].includes(body.supplier_type) ? body.supplier_type : 'wholesaler', name, city,
      str(body.address, 300), str(body.contact, 80), phone, phone, str(body.ntn, 40), int(body.years), str(body.delivery_cities, 200) || city,
      0, ['pending', 'received', 'verified', 'failed'].includes(body.docs_status) ? body.docs_status : body.ntn ? 'received' : 'pending',
      'team', 0, 'active', 0, now()).lastInsertRowid);
    const t = now();
    for (const i of items) {
      if (get('SELECT 1 x FROM listings WHERE supplier_id = ? AND model_id = ?', id, int(i.model_id))) continue;
      const lid = Number(run(`INSERT INTO listings (supplier_id, model_id, price, qty, min_order, token_pct, lead_days, visibility, source, visible,
        price_updated_at, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, int(i.model_id), int(i.price), Math.max(0, int(i.qty, 0)),
        1, Math.min(100, Math.max(0, int(i.token_pct, 20))), Math.max(0, int(i.lead_days, 2)), i.visibility === 'exact' ? 'exact' : 'band',
        'team', 1, t, t, t).lastInsertRowid);
      run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', lid, int(i.price), 'team', t);
    }
    // Welcome first, so it is the first thing the supplier reads; it is completed with the waiting count once known.
    const welcome = (waiting) => `Assalam o Alaikum${body.contact ? ' ' + str(body.contact, 80) + ' sahib' : ''}. Your shop ${name} is ready on Kainat with ${items.length} item(s), set up by our team. Sign in with this number to check it.${waiting ? ` ${waiting} buyer request(s) are already waiting.` : ''}`;
    const sent = notify(id, 'welcome', { body: welcome(0) });
    const waiting = targetOpenRequests(id);
    if (waiting) {
      run('UPDATE notifications SET body = ? WHERE id = ?', welcome(waiting), sent.id);
      if (sent.waId) run('UPDATE wa_messages SET body = ? WHERE id = ?', welcome(waiting), sent.waId);
    }
    return { id, items: items.length, requests_waiting: waiting };
  });
});

route('POST', '/api/admin/suppliers/:id/items', 'admin', ({ params, body }) => {
  const s = get("SELECT * FROM businesses WHERE id = ? AND role = 'supplier'", int(params.id));
  if (!s) fail(404, 'Supplier not found');
  const model = get('SELECT * FROM models WHERE id = ?', int(body.model_id)) || fail(400, 'Pick a model');
  const price = int(body.price) || fail(400, 'Enter a price');
  if (get('SELECT 1 x FROM listings WHERE supplier_id = ? AND model_id = ?', s.id, model.id)) fail(409, 'Already listed for this supplier');
  const t = now();
  const lid = Number(run(`INSERT INTO listings (supplier_id, model_id, price, qty, min_order, token_pct, lead_days, visibility, source, visible,
    price_updated_at, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, s.id, model.id, price, Math.max(0, int(body.qty, 0)), 1,
    int(body.token_pct, 20), int(body.lead_days, 2), body.visibility === 'exact' ? 'exact' : 'band', 'team', 1, t, t, t).lastInsertRowid);
  run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', lid, price, 'team', t);
  return { id: lid };
});

route('GET', '/api/admin/models', 'admin', () => all(`SELECT m.*, b.name submitted_name, (SELECT COUNT(*) FROM listings l WHERE l.model_id = m.id) listings
  FROM models m LEFT JOIN businesses b ON b.id = m.submitted_by ORDER BY CASE m.status WHEN 'pending' THEN 0 ELSE 1 END, m.category, m.brand, m.name`));

route('POST', '/api/admin/models/:id/:action', 'admin', ({ params, body }) => {
  const m = get('SELECT * FROM models WHERE id = ?', int(params.id)) || fail(404, 'Model not found');
  if (params.action === 'approve') run("UPDATE models SET status = 'approved' WHERE id = ?", m.id);
  else if (params.action === 'reject') run("UPDATE models SET status = 'rejected' WHERE id = ?", m.id);
  else if (params.action === 'merge') {
    const into = get('SELECT * FROM models WHERE id = ?', int(body.into)) || fail(400, 'Pick the model to merge into');
    for (const l of all('SELECT * FROM listings WHERE model_id = ?', m.id)) {
      if (get('SELECT 1 x FROM listings WHERE supplier_id = ? AND model_id = ?', l.supplier_id, into.id)) run('UPDATE listings SET visible = 0 WHERE id = ?', l.id);
      else run('UPDATE listings SET model_id = ? WHERE id = ?', into.id, l.id);
    }
    run('UPDATE requests SET model_id = ? WHERE model_id = ?', into.id, m.id);
    run('UPDATE quotes SET model_id = ? WHERE model_id = ?', into.id, m.id);
    run('UPDATE orders SET model_id = ? WHERE model_id = ?', into.id, m.id);
    run("UPDATE models SET status = 'rejected' WHERE id = ?", m.id);
  } else fail(400, 'Unknown action');
  return { ok: true };
});

route('POST', '/api/admin/orders/:id/resolve', 'admin', ({ me, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id = ?', int(params.id)) || fail(404, 'Order not found');
  run('UPDATE orders SET disputed = 0 WHERE id = ?', o.id);
  run('INSERT INTO messages (order_id, sender_id, body, at) VALUES (?,?,?,?)', o.id, me.id, `Kainat team: ${str(body.note, 500) || 'Problem marked as resolved.'}`, now());
  R.maybeReveal(o.id); // ratings held back by the problem can now be shown, if both sides rated
  return { ok: true };
});

route('GET', '/api/admin/ratings', 'admin', ({ query }) => R.adminList({ low: query.low === '1' }));
route('POST', '/api/admin/ratings/:id/hide', 'admin', ({ params, body }) => R.setHidden(int(params.id), body.hidden !== false));

route('GET', '/api/admin/notifications', 'admin', ({ query }) => {
  const rows = all(`SELECT n.id, n.business_id, n.event, n.grp, n.priority, n.body, n.wa_status, n.send_after, n.sent_at, n.read_at, n.created_at, b.name
    FROM notifications n JOIN businesses b ON b.id = n.business_id ${query.status ? 'WHERE n.wa_status = ?' : ''} ORDER BY n.id DESC LIMIT 200`,
  ...(query.status ? [query.status] : []));
  const counts = Object.fromEntries(all(`SELECT wa_status, COUNT(*) n FROM notifications WHERE created_at > ? GROUP BY wa_status`,
    new Date(nowMs() - 7 * DAY).toISOString()).map((r) => [r.wa_status, r.n]));
  return { rows, counts };
});

// The morning price check. The scheduled run skips suppliers who already confirmed their prices today.
function sendPriceCheck({ onlyUnconfirmed = false } = {}) {
  const todayStart = new Date(Date.parse(pktDate() + 'T00:00:00+05:00')).toISOString();
  const sups = all(`SELECT b.id, COUNT(l.id) n, SUM(CASE WHEN l.confirmed_at < ? THEN 1 ELSE 0 END) stale FROM businesses b
    JOIN listings l ON l.supplier_id = b.id AND l.visible = 1 WHERE b.role = 'supplier' AND b.status = 'active' GROUP BY b.id`, todayStart);
  let sent = 0;
  for (const s of sups) {
    if (onlyUnconfirmed && !s.stale) continue;
    notify(s.id, 'price_check', { body: `Good morning. Same prices as yesterday for your ${s.n} items?`, buttons: ['Yes, same', 'Change some'],
      context: { type: 'pricecheck' } });
    sent++;
  }
  return sent;
}

route('POST', '/api/admin/price-check', 'admin', () => tx(() => ({ sent: sendPriceCheck() })));

route('GET', '/api/admin/whatsapp', 'admin', () => all(`SELECT w.*, b.name FROM wa_messages w JOIN businesses b ON b.id = w.business_id
  ORDER BY w.id DESC LIMIT 150`).map((m) => ({ ...m, buttons: m.buttons ? JSON.parse(m.buttons) : null })));

route('GET', '/api/admin/requests', 'admin', () => {
  expireRequests();
  return all(`SELECT r.*, m.brand, m.name, b.name buyer_name, (SELECT COUNT(*) FROM request_targets t WHERE t.request_id = r.id) sent_to,
    (SELECT COUNT(*) FROM quotes q WHERE q.request_id = r.id) quotes FROM requests r LEFT JOIN models m ON m.id = r.model_id
    JOIN businesses b ON b.id = r.buyer_id ORDER BY r.id DESC LIMIT 100`);
});

// ---------- notifications ----------
route('GET', '/api/notifications', 'user', ({ me }) => ({ items: N.listFor(me.id), unread: N.unreadCount(me.id) }));
route('POST', '/api/notifications/read', 'user', ({ me, body }) => { N.markRead(me.id, int(body.id)); return { unread: N.unreadCount(me.id) }; });
const prefsView = (p) => ({ wa_requests: !!p.wa_requests, wa_bidding: !!p.wa_bidding, wa_chat: !!p.wa_chat, wa_shop: !!p.wa_shop,
  wa_ratings: !!p.wa_ratings, quiet_start: p.quiet_start, quiet_end: p.quiet_end });
route('GET', '/api/notify-prefs', 'user', ({ me }) => prefsView(N.prefsFor(me.id)));
route('PUT', '/api/notify-prefs', 'user', ({ me, body }) => prefsView(N.savePrefs(me.id, body)));

// ---------- scheduled jobs ----------
// Run every minute by server.js. Each job is idempotent: running it twice in a row changes nothing the second time.
export const ORDER_REMINDER_AFTER = 4 * HOUR;
export const AUTO_DELIVER_AFTER = 7 * DAY;
export const CLOSING_NOTICE_BEFORE = 6 * HOUR;
export const PRICE_CHECK_HOUR = 8;
export const PRICE_CHECK_UNTIL = 11; // if the server was down all morning, wait for the next day

const JOBS = {
  expire: () => { const before = get("SELECT COUNT(*) n FROM requests WHERE status = 'expired'").n; expireRequests();
    return get("SELECT COUNT(*) n FROM requests WHERE status = 'expired'").n - before; },
  waves: runWaves,
  closing: () => {
    const due = all("SELECT * FROM requests WHERE status = 'open' AND closing_notice_at IS NULL AND expires_at > ? AND expires_at <= ?",
      now(), new Date(nowMs() + CLOSING_NOTICE_BEFORE).toISOString());
    for (const r of due) {
      const bids = get("SELECT COUNT(*) n FROM quotes WHERE request_id = ? AND status = 'active'", r.id).n;
      notify(r.buyer_id, 'request_closing', {
        body: bids ? `Your request for ${requestWhat(r)} closes in about 6 hours. You have ${bids} bid${bids === 1 ? '' : 's'}; accept one before it closes.`
          : `Your request for ${requestWhat(r)} closes in about 6 hours with no bids yet. Widen it or invite a supplier you know.`,
        buttons: bids ? ['See bids'] : ['Widen search', 'Open request'], context: { type: 'request', request_id: r.id }, dedupe: `closing-${r.id}`,
      });
      run('UPDATE requests SET closing_notice_at = ? WHERE id = ?', now(), r.id);
    }
    return due.length;
  },
  orderReminders: () => {
    const due = all("SELECT * FROM orders WHERE status = 'pending' AND accept_reminded_at IS NULL AND created_at <= ?", new Date(nowMs() - ORDER_REMINDER_AFTER).toISOString());
    for (const o of due) {
      const buyer = get('SELECT name FROM businesses WHERE id = ?', o.buyer_id);
      notify(o.supplier_id, 'order_reminder', { body: `Order #${o.id} from ${buyer.name} has waited 4 hours. Accept or decline it so they can plan.`,
        buttons: ['Accept', 'Decline'], context: { type: 'order', order_id: o.id }, dedupe: `remind-${o.id}` });
      run('UPDATE orders SET accept_reminded_at = ? WHERE id = ?', now(), o.id);
    }
    return due.length;
  },
  autoDeliver: () => {
    const due = all("SELECT * FROM orders WHERE status = 'dispatched' AND dispatched_at <= ?", new Date(nowMs() - AUTO_DELIVER_AFTER).toISOString());
    for (const o of due) markDelivered(o, { auto: true });
    return due.length;
  },
  ratings: () => { const r = R.ratingJobs(); return r.revealed + r.reminded; },
  priceCheck: () => {
    // Only in the morning window: a server started in the afternoon must not send "Good morning" at 3 pm.
    const h = pktHour();
    if (h < PRICE_CHECK_HOUR || h >= PRICE_CHECK_UNTIL) return 0;
    const today = pktDate();
    if (get("SELECT value FROM job_state WHERE key = 'price_check_date'")?.value === today) return 0;
    run("INSERT INTO job_state (key, value) VALUES ('price_check_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", today);
    return sendPriceCheck({ onlyUnconfirmed: true });
  },
  flush: N.flushWaiting,
  // Housekeeping: old code requests and ended sessions.
  cleanup: () => {
    const a = Number(run('DELETE FROM otp_requests WHERE at < ?', new Date(nowMs() - DAY).toISOString()).changes);
    const b = Number(run('DELETE FROM sessions WHERE COALESCE(last_seen, created_at) < ? OR created_at < ?',
      new Date(nowMs() - SESSION_IDLE_MS).toISOString(), new Date(nowMs() - SESSION_MAX_MS).toISOString()).changes);
    const c = Number(run('DELETE FROM otps WHERE at < ?', new Date(nowMs() - OTP_TTL_MS).toISOString()).changes);
    return a + b + c;
  },
};

export function runJobs(names = Object.keys(JOBS)) {
  const out = {};
  for (const n of names) {
    if (!JOBS[n]) continue;
    try { out[n] = tx(() => JOBS[n]()); } catch (e) { console.error(`Job ${n} failed:`, e); out[n] = 'error'; }
  }
  return out;
}

// Test hooks: move the clock and run jobs on demand. Only present when the server starts with TEST_HOOKS=1.
if (process.env.TEST_HOOKS === '1') {
  route('POST', '/api/test/clock', 'public', ({ body }) => ({ now: setClock({ set: body.set, advanceMs: Number(body.advance_minutes || 0) * MIN }) }));
  route('POST', '/api/test/tick', 'public', ({ body }) => runJobs(Array.isArray(body.jobs) ? body.jobs : undefined));
}

route('GET', '/api/health', 'public', () => ({ ok: true, time: now() }));

// Pure helpers exposed for unit tests only.
export const _internals = { normPhone, int, str, dayLabel, leadText, dealsText, band, staleDays, cityMatch, parseQuoteText, rs };
