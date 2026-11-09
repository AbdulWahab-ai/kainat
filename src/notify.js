// Notification engine. Features report an event; this decides who is told, how and when.
//
// Every notification is saved first (the in-app list and the record of what was sent), then delivered to
// WhatsApp if the business allows it:
// - urgent events go out at once
// - normal events go out at once unless the business had any WhatsApp alert in the last 15 minutes; then they
//   wait and are sent together as one message
// - during quiet hours (Pakistan time) WhatsApp waits until the quiet hours end; new orders still go through
// The WhatsApp channel is simulated: delivery writes to wa_messages, which the app's WhatsApp screen shows.
// A real WhatsApp Business Platform sender would replace deliverWa() only.
import { all, get, run } from './db.js';
import { nowMs, nowIso, MIN, DAY, pktHour, nextPktHour } from './clock.js';

export const EVENTS = {
  welcome: { grp: 'account', priority: 'urgent' },
  invited: { grp: 'account', priority: 'urgent' },
  request_match: { grp: 'requests', priority: 'urgent' },
  request_no_bids: { grp: 'requests', priority: 'urgent' },
  request_closing: { grp: 'requests', priority: 'normal' },
  request_expired: { grp: 'requests', priority: 'normal' },
  bid_first: { grp: 'bidding', priority: 'urgent' },
  bid_new: { grp: 'bidding', priority: 'normal' },
  bid_revised: { grp: 'bidding', priority: 'normal' },
  outbid: { grp: 'bidding', priority: 'urgent' },
  order_new: { grp: 'orders', priority: 'urgent', bypassQuiet: true },
  order_update: { grp: 'orders', priority: 'urgent' },
  order_reminder: { grp: 'orders', priority: 'urgent' },
  order_message: { grp: 'orders', priority: 'normal' },
  chat_message: { grp: 'chat', priority: 'normal' },
  price_check: { grp: 'shop', priority: 'urgent' },
  rate_prompt: { grp: 'ratings', priority: 'normal' },
  rate_reminder: { grp: 'ratings', priority: 'normal' },
  rating_revealed: { grp: 'ratings', priority: 'normal' },
};

// Groups a business can switch off for WhatsApp. Orders and account messages always go out.
export const WA_GROUPS = ['requests', 'bidding', 'chat', 'shop', 'ratings'];
export const BATCH_WINDOW_MS = 15 * MIN;
// Alerts for requests where the supplier does not hold the exact model, per rolling 24 hours.
export const DAILY_REQUEST_CAP = 10;

function defaultQuiet() {
  const v = (process.env.DEFAULT_QUIET ?? '22-8').trim();
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
  return m ? { quiet_start: Number(m[1]) % 24, quiet_end: Number(m[2]) % 24 } : { quiet_start: null, quiet_end: null };
}

export function prefsFor(businessId) {
  const p = get('SELECT * FROM notify_prefs WHERE business_id = ?', businessId);
  if (p) return p;
  return { business_id: businessId, wa_requests: 1, wa_bidding: 1, wa_chat: 1, wa_shop: 1, wa_ratings: 1, ...defaultQuiet() };
}

export function savePrefs(businessId, body) {
  const cur = prefsFor(businessId);
  const flag = (k) => (body[k] === undefined ? cur[k] : body[k] === true || body[k] === 1 || body[k] === '1' || body[k] === 'on' ? 1 : 0);
  const hour = (v, fallback) => {
    if (v === undefined) return fallback;
    if (v === null || v === '' || v === 'off') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
  };
  let qs = hour(body.quiet_start, cur.quiet_start);
  let qe = hour(body.quiet_end, cur.quiet_end);
  if (qs === null || qe === null || qs === qe) { qs = null; qe = null; }
  run(`INSERT INTO notify_prefs (business_id, wa_requests, wa_bidding, wa_chat, wa_shop, wa_ratings, quiet_start, quiet_end, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(business_id) DO UPDATE SET wa_requests = excluded.wa_requests, wa_bidding = excluded.wa_bidding,
    wa_chat = excluded.wa_chat, wa_shop = excluded.wa_shop, wa_ratings = excluded.wa_ratings, quiet_start = excluded.quiet_start,
    quiet_end = excluded.quiet_end, updated_at = excluded.updated_at`,
  businessId, flag('wa_requests'), flag('wa_bidding'), flag('wa_chat'), flag('wa_shop'), flag('wa_ratings'), qs, qe, nowIso());
  return prefsFor(businessId);
}

export function inQuiet(p, ms = nowMs()) {
  if (p.quiet_start === null || p.quiet_end === null || p.quiet_start === undefined) return false;
  const h = pktHour(ms);
  return p.quiet_start > p.quiet_end ? h >= p.quiet_start || h < p.quiet_end : h >= p.quiet_start && h < p.quiet_end;
}
const quietEndsAt = (p, ms = nowMs()) => new Date(nextPktHour(p.quiet_end, ms)).toISOString();

export function linkFor(ctx, role) {
  if (!ctx) return null;
  if (ctx.order_id) return `#/order/${ctx.order_id}`;
  if (ctx.conversation_id) return `#/chat/${ctx.conversation_id}`;
  if (ctx.request_id) return role === 'supplier' ? `#/s/quote/${ctx.request_id}` : `#/b/request/${ctx.request_id}`;
  if (ctx.type === 'pricecheck' || ctx.type === 'shop') return '#/s/shop';
  if (ctx.type === 'digest') return '#/notifications';
  return null;
}

function deliverWa(businessId, body, buttons, context) {
  return Number(run('INSERT INTO wa_messages (business_id, direction, body, buttons, context, at) VALUES (?,?,?,?,?,?)',
    businessId, 'out', body, buttons ? JSON.stringify(buttons) : null, context ? JSON.stringify(context) : null, nowIso()).lastInsertRowid);
}

// Report an event to one business. Returns { id, waId } (waId is null when WhatsApp waits or is off), or null
// when a notification with the same dedupe key was already sent.
export function notify(businessId, event, { body, buttons = null, context = null, link = null, dedupe = null } = {}) {
  const ev = EVENTS[event];
  if (!ev) throw new Error(`Unknown notification event: ${event}`);
  if (!businessId || !body) return null;
  if (dedupe && get('SELECT 1 x FROM notifications WHERE dedupe_key = ?', dedupe)) return null;
  const biz = get('SELECT role, status FROM businesses WHERE id = ?', businessId);
  if (!biz) return null;
  const p = prefsFor(businessId);
  const t = nowMs();
  let status = 'sent';
  let sendAfter = null;
  if (WA_GROUPS.includes(ev.grp) && !p[`wa_${ev.grp}`]) status = 'off';
  else if (biz.status !== 'active') status = 'off';
  else if (event === 'request_match' && !context?.match && requestAlertsToday(businessId) >= DAILY_REQUEST_CAP) status = 'capped';
  else if (!ev.bypassQuiet && inQuiet(p, t)) { status = 'held'; sendAfter = quietEndsAt(p, t); }
  else if (ev.priority === 'normal') {
    // Any WhatsApp in the last 15 minutes (urgent ones too) means this one waits for the next batch.
    const recent = get(`SELECT MAX(sent_at) s FROM notifications WHERE business_id = ? AND wa_status IN ('sent','batched')
      AND sent_at > ?`, businessId, new Date(t - BATCH_WINDOW_MS).toISOString()).s;
    const waiting = get("SELECT MIN(send_after) s FROM notifications WHERE business_id = ? AND wa_status = 'queued'", businessId).s;
    if (waiting) { status = 'queued'; sendAfter = waiting; }
    else if (recent) { status = 'queued'; sendAfter = new Date(Date.parse(recent) + BATCH_WINDOW_MS).toISOString(); }
  }
  const at = new Date(t).toISOString();
  const id = Number(run(`INSERT INTO notifications (business_id, event, grp, priority, body, buttons, context, link, wa_status, send_after,
    dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, businessId, event, ev.grp, ev.priority, body,
  buttons ? JSON.stringify(buttons) : null, context ? JSON.stringify(context) : null, link || linkFor(context, biz.role), status,
  sendAfter, dedupe, at).lastInsertRowid);
  let waId = null;
  if (status === 'sent') {
    waId = deliverWa(businessId, body, buttons, context);
    run('UPDATE notifications SET sent_at = ?, wa_message_id = ? WHERE id = ?', at, waId, id);
  }
  return { id, waId, status };
}

function requestAlertsToday(businessId) {
  return get(`SELECT COUNT(*) n FROM notifications WHERE business_id = ? AND event = 'request_match' AND wa_status IN ('sent','batched','queued','held')
    AND created_at > ? AND json_extract(context, '$.match') IS NOT 1`, businessId, new Date(nowMs() - DAY).toISOString()).n;
}

// Send WhatsApp messages that were waiting (batched or held for quiet hours). Several waiting messages for one
// business go out as one summary. Returns the number of WhatsApp messages sent.
export function flushWaiting() {
  const t = nowMs();
  const at = new Date(t).toISOString();
  const due = all("SELECT * FROM notifications WHERE wa_status IN ('queued','held') AND send_after <= ? ORDER BY business_id, id", at);
  const byBiz = new Map();
  for (const n of due) (byBiz.get(n.business_id) || byBiz.set(n.business_id, []).get(n.business_id)).push(n);
  let sent = 0;
  for (const [bizId, rows] of byBiz) {
    const p = prefsFor(bizId);
    if (inQuiet(p, t)) {
      run(`UPDATE notifications SET wa_status = 'held', send_after = ? WHERE business_id = ? AND wa_status IN ('queued','held') AND send_after <= ?`,
        quietEndsAt(p, t), bizId, at);
      continue;
    }
    // A notification still current in its own right goes out as it was written.
    if (rows.length === 1) {
      const n = rows[0];
      const waId = deliverWa(bizId, n.body, n.buttons ? JSON.parse(n.buttons) : null, n.context ? JSON.parse(n.context) : null);
      run("UPDATE notifications SET wa_status = 'sent', sent_at = ?, wa_message_id = ? WHERE id = ?", at, waId, n.id);
    } else {
      const lines = rows.slice(0, 8).map((n) => `• ${n.body.split('\n')[0].slice(0, 110)}`);
      if (rows.length > 8) lines.push(`• and ${rows.length - 8} more`);
      const waId = deliverWa(bizId, `${rows.length} updates on Kainat:\n${lines.join('\n')}`, ['Open notifications'], { type: 'digest' });
      run(`UPDATE notifications SET wa_status = 'batched', sent_at = ?, wa_message_id = ? WHERE id IN (${rows.map(() => '?').join(',')})`,
        at, waId, ...rows.map((n) => n.id));
    }
    sent++;
  }
  return sent;
}

export function listFor(businessId, limit = 60) {
  return all('SELECT id, event, grp, priority, body, link, wa_status, sent_at, read_at, created_at FROM notifications WHERE business_id = ? ORDER BY id DESC LIMIT ?',
    businessId, limit);
}
export const unreadCount = (businessId) => get('SELECT COUNT(*) n FROM notifications WHERE business_id = ? AND read_at IS NULL', businessId).n;
export function markRead(businessId, id = null) {
  if (id) return run('UPDATE notifications SET read_at = ? WHERE business_id = ? AND id = ? AND read_at IS NULL', nowIso(), businessId, id);
  return run('UPDATE notifications SET read_at = ? WHERE business_id = ? AND read_at IS NULL', nowIso(), businessId);
}
