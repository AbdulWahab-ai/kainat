// Two-way ratings after a delivered order.
//
// Rules:
// - Only the buyer and supplier of a delivered order can rate, within 30 days of delivery. One rating each per order.
// - Blind: neither side sees the other's rating until both have rated, or 14 days after the first rating.
//   A rating can be changed until it is revealed.
// - Orders with a flagged problem keep their ratings hidden until the Kainat team resolves the problem.
// - A score shows only from 3 ratings. Only the last 12 months count, and only the latest rating from each
//   partner, so two friendly businesses cannot push each other up with many small orders.
// - The Kainat team can hide an abusive comment but never change the stars.
import { all, get, run } from './db.js';
import { nowMs, nowIso, DAY } from './clock.js';
import { notify } from './notify.js';

export const TAGS = {
  buyer: ['Price as quoted', 'On time', 'Genuine stock', 'Good packing', 'Responsive'],
  supplier: ['Paid token on time', 'Clear requirements', 'Easy to deal with', 'Received promptly'],
};
export const RATING_WINDOW_MS = 30 * DAY;
export const REVEAL_AFTER_MS = 14 * DAY;
export const REMIND_AFTER_MS = 3 * DAY;
export const MIN_TO_SHOW = 3;
export const STAR_BUTTONS = ['5 ★', '4 ★', '3 ★', '2 ★', '1 ★'];

class RatingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new RatingError(status, message); };
export { RatingError };

const parseTags = (t) => { try { return t ? JSON.parse(t) : []; } catch { return []; } };
const name = (id) => get('SELECT name FROM businesses WHERE id = ?', id)?.name || 'The other side';

// Score shown on profiles and cards. avg is null until there are MIN_TO_SHOW ratings.
export function summary(bizId) {
  const since = new Date(nowMs() - 365 * DAY).toISOString();
  const rows = all(`SELECT r.stars, r.tags FROM ratings r WHERE r.ratee_id = ? AND r.revealed_at IS NOT NULL AND r.created_at > ?
    AND r.id = (SELECT MAX(r2.id) FROM ratings r2 WHERE r2.ratee_id = r.ratee_id AND r2.rater_id = r.rater_id AND r2.revealed_at IS NOT NULL AND r2.created_at > ?)`,
  bizId, since, since);
  const count = rows.length;
  if (!count) return { avg: null, count: 0, top_tags: [] };
  const tally = {};
  for (const r of rows) for (const t of parseTags(r.tags)) tally[t] = (tally[t] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => ({ tag: t, n }));
  const avg = Math.round((rows.reduce((s, r) => s + r.stars, 0) / count) * 10) / 10;
  return { avg: count >= MIN_TO_SHOW ? avg : null, count, top_tags: top };
}

// The stars the viewer last gave this business ("You rated them 5 last time").
export const lastGiven = (viewerId, bizId) =>
  get('SELECT stars FROM ratings WHERE rater_id = ? AND ratee_id = ? ORDER BY id DESC LIMIT 1', viewerId, bizId)?.stars ?? null;

export function reviewsFor(bizId, limit = 10) {
  return all(`SELECT r.id, r.stars, r.tags, r.comment, r.hidden, r.reply, r.reply_at, r.created_at, r.rater_role, b.name rater_name
    FROM ratings r JOIN businesses b ON b.id = r.rater_id WHERE r.ratee_id = ? AND r.revealed_at IS NOT NULL ORDER BY r.id DESC LIMIT ?`, bizId, limit)
    .map((r) => ({ ...r, tags: parseTags(r.tags), comment: r.hidden ? null : r.comment, hidden: !!r.hidden }));
}

const view = (r) => (r ? { id: r.id, stars: r.stars, tags: parseTags(r.tags), comment: r.hidden ? null : r.comment, hidden: !!r.hidden,
  reply: r.reply, reply_at: r.reply_at, created_at: r.created_at, revealed_at: r.revealed_at } : null);

// What the order page shows: whether the viewer can rate, their own rating, and the other side's once revealed.
export function forOrder(o, me) {
  const party = me && (o.buyer_id === me.id || o.supplier_id === me.id);
  const rows = all('SELECT * FROM ratings WHERE order_id = ?', o.id);
  const out = { window_open: false, can_rate: false, tags: [], mine: null, theirs: null, waiting_for_other: false };
  if (o.status !== 'delivered' || !o.delivered_at) return admin(out, rows, me);
  const windowEnds = Date.parse(o.delivered_at) + RATING_WINDOW_MS;
  out.window_open = nowMs() <= windowEnds;
  out.window_ends = new Date(windowEnds).toISOString();
  if (!party) return admin(out, rows, me);
  const role = o.buyer_id === me.id ? 'buyer' : 'supplier';
  const mine = rows.find((r) => r.rater_id === me.id);
  const theirs = rows.find((r) => r.rater_id !== me.id);
  out.tags = TAGS[role];
  out.mine = view(mine);
  out.can_rate = out.window_open && (!mine || !mine.revealed_at);
  out.theirs = theirs?.revealed_at ? view(theirs) : null;
  out.waiting_for_other = !!mine && !mine.revealed_at;
  if (mine && !mine.revealed_at) out.reveal_by = new Date(Date.parse(mine.created_at) + REVEAL_AFTER_MS).toISOString();
  out.held_for_problem = !!o.disputed && !!mine && !mine.revealed_at;
  return out;
}
function admin(out, rows, me) {
  if (me?.is_admin) out.all = rows.map((r) => ({ ...view(r), rater_id: r.rater_id, rater_role: r.rater_role }));
  return out;
}

export function submit(o, me, body) {
  if (o.buyer_id !== me.id && o.supplier_id !== me.id) fail(403, 'Only the buyer and supplier of this order can rate it');
  if (o.status !== 'delivered' || !o.delivered_at) fail(409, 'You can rate a deal once it is delivered');
  if (nowMs() > Date.parse(o.delivered_at) + RATING_WINDOW_MS) fail(409, 'Rating closes 30 days after delivery');
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail(400, 'Choose 1 to 5 stars');
  const role = o.buyer_id === me.id ? 'buyer' : 'supplier';
  const ratee = role === 'buyer' ? o.supplier_id : o.buyer_id;
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.filter((t) => TAGS[role].includes(t)))] : [];
  const comment = body.comment === undefined || body.comment === null ? null : String(body.comment).trim().slice(0, 500) || null;
  const existing = get('SELECT * FROM ratings WHERE order_id = ? AND rater_id = ?', o.id, me.id);
  const t = nowIso();
  if (existing) {
    if (existing.revealed_at) fail(409, 'Your rating has been shown to them and can no longer be changed');
    // A WhatsApp star tap only sets the stars; keep tags and comment from the app.
    const keep = body.starsOnly;
    run('UPDATE ratings SET stars = ?, tags = ?, comment = ?, updated_at = ? WHERE id = ?', stars,
      keep ? existing.tags : JSON.stringify(tags), keep ? existing.comment : comment, t, existing.id);
  } else {
    run(`INSERT INTO ratings (order_id, rater_id, ratee_id, rater_role, stars, tags, comment, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      o.id, me.id, ratee, role, stars, JSON.stringify(tags), comment, t, t);
    // Nudge the other side, without saying what the rating was.
    if (!get('SELECT 1 x FROM ratings WHERE order_id = ? AND rater_id = ?', o.id, ratee)) {
      notify(ratee, 'rate_prompt', {
        body: `${me.name} has rated your deal on order #${o.id}. Rate them too to see what they said. Ratings stay hidden until you both rate, or for 14 days.`,
        buttons: STAR_BUTTONS, context: { type: 'rate', order_id: o.id }, dedupe: `rate-nudge-${o.id}-${ratee}`,
      });
    }
  }
  maybeReveal(o.id);
  return get('SELECT * FROM ratings WHERE order_id = ? AND rater_id = ?', o.id, me.id);
}

// Reveal an order's ratings when both sides have rated, or when the first rating is 14 days old.
export function maybeReveal(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o || o.disputed) return 0;
  const hidden = all('SELECT * FROM ratings WHERE order_id = ? AND revealed_at IS NULL', orderId);
  if (!hidden.length) return 0;
  const both = get('SELECT COUNT(*) n FROM ratings WHERE order_id = ?', orderId).n >= 2;
  const oldest = Math.min(...hidden.map((r) => Date.parse(r.created_at)));
  if (!both && nowMs() - oldest < REVEAL_AFTER_MS) return 0;
  const t = nowIso();
  for (const r of hidden) {
    run('UPDATE ratings SET revealed_at = ? WHERE id = ?', t, r.id);
    notify(r.ratee_id, 'rating_revealed', {
      body: `${name(r.rater_id)} rated your deal on order #${orderId}: ${r.stars} ★.${r.comment && !r.hidden ? ` They wrote: “${r.comment.slice(0, 120)}”` : ''} You can reply once from the order page.`,
      buttons: ['Open order'], context: { type: 'order', order_id: orderId },
    });
  }
  return hidden.length;
}

export function reply(ratingId, me, text) {
  const r = get('SELECT * FROM ratings WHERE id = ?', ratingId) || fail(404, 'Rating not found');
  if (r.ratee_id !== me.id) fail(403, 'Only the business that was rated can reply');
  if (!r.revealed_at) fail(409, 'You can reply once the rating is shown');
  if (r.reply) fail(409, 'You have already replied to this rating');
  const body = String(text || '').trim().slice(0, 500);
  if (!body) fail(400, 'Type a reply');
  run('UPDATE ratings SET reply = ?, reply_at = ? WHERE id = ?', body, nowIso(), r.id);
  return { ok: true };
}

// Scheduled: reveal ratings that waited 14 days, and remind each side once, 3 days after delivery, if they have not rated.
export function ratingJobs() {
  let revealed = 0;
  for (const { order_id } of all('SELECT DISTINCT order_id FROM ratings WHERE revealed_at IS NULL')) revealed += maybeReveal(order_id);
  const t = nowMs();
  const due = all(`SELECT * FROM orders WHERE status = 'delivered' AND rating_reminded_at IS NULL AND delivered_at < ? AND delivered_at > ?`,
    new Date(t - REMIND_AFTER_MS).toISOString(), new Date(t - RATING_WINDOW_MS).toISOString());
  let reminded = 0;
  for (const o of due) {
    for (const [who, other] of [[o.buyer_id, o.supplier_id], [o.supplier_id, o.buyer_id]]) {
      if (get('SELECT 1 x FROM ratings WHERE order_id = ? AND rater_id = ?', o.id, who)) continue;
      const r = notify(who, 'rate_reminder', {
        body: `How was your deal with ${name(other)} on order #${o.id}? Rating closes ${new Date(Date.parse(o.delivered_at) + RATING_WINDOW_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`,
        buttons: STAR_BUTTONS, context: { type: 'rate', order_id: o.id }, dedupe: `rate-remind-${o.id}-${who}`,
      });
      if (r) reminded++;
    }
    run('UPDATE orders SET rating_reminded_at = ? WHERE id = ?', new Date(t).toISOString(), o.id);
  }
  return { revealed, reminded };
}

export function adminList({ low } = {}) {
  return all(`SELECT r.*, a.name rater_name, b.name ratee_name FROM ratings r JOIN businesses a ON a.id = r.rater_id JOIN businesses b ON b.id = r.ratee_id
    ${low ? 'WHERE r.stars <= 2' : ''} ORDER BY r.id DESC LIMIT 200`).map((r) => ({ ...r, tags: parseTags(r.tags), hidden: !!r.hidden }));
}
export const lowCount = () => get('SELECT COUNT(*) n FROM ratings WHERE stars <= 2 AND hidden = 0 AND created_at > ?', new Date(nowMs() - 30 * DAY).toISOString()).n;
export function setHidden(id, hidden) {
  const r = get('SELECT id FROM ratings WHERE id = ?', id) || fail(404, 'Rating not found');
  run('UPDATE ratings SET hidden = ? WHERE id = ?', hidden ? 1 : 0, r.id);
  return { ok: true };
}
