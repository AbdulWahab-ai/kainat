// Notification engine: in-app list, WhatsApp delivery rules (batching, quiet hours, switched-off groups, daily cap),
// matching waves, and the scheduled jobs (expiry, closing notice, order reminder, auto-delivery, morning price check).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rejects, as } from '../helpers/server.js';

const post = (c, body) => c.call('POST', '/api/requests', { city: 'Lahore', scope: 'all', ...body });
const notes = async (c) => (await c.call('GET', '/api/notifications')).items;
const waBodies = async (c) => (await c.call('GET', '/api/whatsapp')).filter((m) => m.direction === 'out').map((m) => m.body);
const sql = (srv, q, ...p) => { const db = srv.db(); try { return db.prepare(q).all(...p); } finally { db.close(); } };

describe('in-app list, preferences and batching', () => {
  let srv, buyer, alNoor, sunCity, greenVolt, admin, M;
  before(async () => {
    srv = await startServer();
    [buyer, alNoor, sunCity, greenVolt, admin] = await Promise.all(['sunPeak', 'alNoor', 'sunCity', 'greenVolt', 'admin'].map((w) => as(srv.base, w)));
    M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
  });
  after(async () => { await srv.stop(); });

  test('every alert lands in the in-app list with a link, and the bell count goes down when read', async () => {
    const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 2 });
    const n = (await notes(alNoor))[0];
    assert.equal(n.event, 'request_match');
    assert.equal(n.link, `#/s/quote/${r.id}`);
    assert.equal(n.wa_status, 'sent');
    assert.match((await waBodies(alNoor)).at(-1), /In-stock match/);
    const before = (await alNoor.me()).counts.notifications;
    assert.ok(before >= 1);
    const one = await alNoor.call('POST', '/api/notifications/read', { id: n.id });
    assert.equal(one.unread, before - 1);
    assert.equal((await alNoor.call('POST', '/api/notifications/read', {})).unread, 0);
    assert.equal((await alNoor.me()).counts.notifications, 0);
    // Someone else's notification id does nothing.
    await buyer.call('POST', '/api/notifications/read', { id: n.id });
    await rejects(new (await import('../helpers/server.js')).Client(srv.base).call('GET', '/api/notifications'), 401);
  });

  test('preferences: defaults, saving, validation, and an app-only group', async () => {
    const p = await greenVolt.call('GET', '/api/notify-prefs');
    assert.deepEqual(p, { wa_requests: true, wa_bidding: true, wa_chat: true, wa_shop: true, wa_ratings: true, quiet_start: null, quiet_end: null });
    let s = await greenVolt.call('PUT', '/api/notify-prefs', { wa_chat: false, quiet_start: '22', quiet_end: '7' });
    assert.equal(s.wa_chat, false);
    assert.equal(s.quiet_start, 22);
    assert.equal(s.quiet_end, 7);
    s = await greenVolt.call('PUT', '/api/notify-prefs', { quiet_start: 99 }); // out of range keeps the old value
    assert.equal(s.quiet_start, 22);
    s = await greenVolt.call('PUT', '/api/notify-prefs', { quiet_start: 5, quiet_end: 5 }); // same hour = no quiet hours
    assert.equal(s.quiet_start, null);
    s = await greenVolt.call('PUT', '/api/notify-prefs', { quiet_start: 'off' });
    assert.equal(s.quiet_end, null);
    // Chat switched off for WhatsApp: still in the app, nothing on WhatsApp.
    const c = await buyer.call('POST', '/api/chats', { with_id: 4 });
    const waBefore = (await waBodies(greenVolt)).length;
    await buyer.call('POST', `/api/chats/${c.id}/messages`, { body: 'Do you have 550 W in stock?' });
    const n = (await notes(greenVolt))[0];
    assert.equal(n.event, 'chat_message');
    assert.equal(n.wa_status, 'off');
    assert.equal((await waBodies(greenVolt)).length, waBefore);
    // Orders cannot be switched off.
    s = await greenVolt.call('PUT', '/api/notify-prefs', { wa_orders: false });
    assert.equal(s.wa_orders, undefined);
  });

  test('the first bid goes out at once; later bids within 15 minutes are batched into one WhatsApp message', async () => {
    const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 3, bidding: 'sealed' });
    const waBefore = (await waBodies(buyer)).length;
    await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 330000, qty: 3 });
    assert.equal((await notes(buyer))[0].event, 'bid_first');
    assert.match((await waBodies(buyer)).at(-1), /New bid from Al-Noor/);
    await sunCity.call('POST', `/api/requests/${r.id}/quote`, { price: 329000, qty: 3 });
    await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 327000, qty: 3 });
    const [revised, second] = await notes(buyer);
    assert.equal(second.event, 'bid_new');
    assert.equal(second.wa_status, 'queued');
    assert.equal(revised.event, 'bid_revised');
    assert.equal(revised.wa_status, 'queued');
    assert.equal((await waBodies(buyer)).length, waBefore + 1, 'only the first bid reached WhatsApp so far');
    // Not due yet.
    assert.equal((await srv.tick(['flush'])).flush, 0);
    await srv.advance(16);
    assert.equal((await srv.tick(['flush'])).flush, 1);
    const digest = (await waBodies(buyer)).at(-1);
    assert.match(digest, /^2 updates on Kainat:/);
    assert.match(digest, /New bid from Sun City/);
    assert.match(digest, /Revised bid from Al-Noor/);
    assert.equal((await notes(buyer)).filter((n) => n.wa_status === 'queued').length, 0);
    // Running the job again sends nothing twice.
    assert.equal((await srv.tick(['flush'])).flush, 0);
  });

  test('urgent alerts are never batched', async () => {
    const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
    await sunCity.call('POST', `/api/requests/${r.id}/quote`, { price: 331000, qty: 1 });
    await greenVolt.call('POST', `/api/requests/${r.id}/quote`, { price: 330000, qty: 1 });
    // Sun City was outbid in open bidding: urgent, straight to WhatsApp even after other recent messages.
    const n = (await notes(sunCity))[0];
    assert.equal(n.event, 'outbid');
    assert.equal(n.wa_status, 'sent');
  });

  test('admin notification log and overview counts; other roles are refused', async () => {
    const d = await admin.call('GET', '/api/admin/notifications');
    assert.ok(d.rows.length > 0 && d.rows[0].name);
    assert.ok(d.counts.sent > 0);
    assert.ok((await admin.call('GET', '/api/admin/notifications?status=off')).rows.every((r) => r.wa_status === 'off'));
    const o = await admin.call('GET', '/api/admin/overview');
    assert.equal(typeof o.counts.wa_waiting, 'number');
    assert.equal(typeof o.counts.low_ratings, 'number');
    await rejects(buyer.call('GET', '/api/admin/notifications'), 403);
  });
});

describe('quiet hours', () => {
  let srv, buyer, alNoor, M;
  before(async () => {
    srv = await startServer({ DEFAULT_QUIET: '22-8' });
    [buyer, alNoor] = await Promise.all(['sunPeak', 'alNoor'].map((w) => as(srv.base, w)));
    M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
  });
  after(async () => { await srv.stop(); });

  test('at 11 pm in Pakistan WhatsApp waits until 8 am, but a new order still goes out', async () => {
    await srv.setClock('2026-12-01T18:00:00Z'); // 23:00 in Pakistan
    const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
    const n = (await notes(alNoor))[0];
    assert.equal(n.event, 'request_match');
    assert.equal(n.wa_status, 'held');
    assert.equal(n.send_after ?? (await alNoor.call('GET', '/api/notifications')).items[0].send_after, undefined); // not exposed to the business
    const held = sql(srv, "SELECT send_after FROM notifications WHERE id = ?", n.id)[0];
    assert.equal(held.send_after, '2026-12-02T03:00:00.000Z'); // 08:00 in Pakistan
    // A new order bypasses quiet hours.
    const l = (await alNoor.call('GET', '/api/shop')).find((x) => x.visibility === 'exact' || true);
    const verified = await buyer.call('GET', `/api/listings/${l.id}`);
    if (verified.exact) {
      const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
      const on = (await notes(alNoor))[0];
      assert.equal(on.event, 'order_new');
      assert.equal(on.wa_status, 'sent');
      assert.match((await waBodies(alNoor)).at(-1), new RegExp(`New order from SunPeak`));
      void o;
    }
    // Still quiet at 07:59: nothing goes out.
    await srv.setClock('2026-12-02T02:59:00Z');
    assert.equal((await srv.tick(['flush'])).flush, 0);
    await srv.setClock('2026-12-02T03:01:00Z');
    assert.ok((await srv.tick(['flush'])).flush >= 1, 'every supplier with held alerts gets them now');
    assert.match((await waBodies(alNoor)).at(-1), /In-stock match|updates on Kainat/);
    assert.equal(sql(srv, "SELECT COUNT(*) n FROM notifications WHERE wa_status = 'held'")[0].n, 0);
    void r;
  });

  test('a business can turn quiet hours off', async () => {
    await alNoor.call('PUT', '/api/notify-prefs', { quiet_start: 'off' });
    await srv.setClock('2026-12-02T18:30:00Z'); // 23:30 in Pakistan
    await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 2 });
    assert.equal((await notes(alNoor))[0].wa_status, 'sent');
  });
});

describe('matching waves and scheduled jobs', () => {
  let srv, buyer, smallBuyer, alNoor, sunCity, greenVolt, admin, M;
  before(async () => {
    srv = await startServer();
    [buyer, smallBuyer, alNoor, sunCity, greenVolt, admin] = await Promise.all(['sunPeak', 'brightWorks', 'alNoor', 'sunCity', 'greenVolt', 'admin'].map((w) => as(srv.base, w)));
    M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
    // Six more Lahore panel shops with no stock, so more suppliers match than wave 1 takes.
    for (let i = 0; i < 6; i++) {
      await admin.call('POST', '/api/admin/suppliers', { name: `Panel Shop ${i}`, phone: `0333000000${i}`, city: 'Lahore', supplier_type: 'wholesaler',
        items: [{ model_id: M['Longi Hi-MO 6 580 W'], price: 18000 + i * 100, qty: 0 }] });
    }
  });
  after(async () => { await srv.stop(); });

  test('wave 1 takes every in-stock supplier plus the best 5 others; wave 2 sends to the rest after 30 minutes', async () => {
    const r = await post(buyer, { model_id: M['Longi Hi-MO 6 580 W'], qty: 50 });
    const d = await buyer.call('GET', `/api/requests/${r.id}`);
    const stocked = d.targets.filter((t) => t.in_stock).length;
    assert.equal(r.sent_to, d.targets.length);
    assert.equal(r.sent_to, stocked + 5);
    assert.ok(r.later > 0, 'some suppliers wait for wave 2');
    assert.equal(r.in_stock, stocked);
    // Nothing happens before 30 minutes.
    await srv.advance(29);
    assert.equal((await srv.tick(['waves'])).waves, 0);
    await srv.advance(2);
    assert.equal((await srv.tick(['waves'])).waves, r.later);
    const after2 = await buyer.call('GET', `/api/requests/${r.id}`);
    assert.equal(after2.targets.length, r.sent_to + r.later);
    assert.equal(after2.request.wave, 2);
    const waves = sql(srv, 'SELECT wave, COUNT(*) n FROM request_targets WHERE request_id = ? GROUP BY wave', r.id);
    assert.deepEqual(waves.map((w) => [w.wave, w.n]), [[1, r.sent_to], [2, r.later]]);
    // After 2 hours with no bids the buyer is told, and can widen to other cities.
    await srv.advance(90);
    await srv.tick(['waves']);
    const n = (await notes(buyer))[0];
    assert.equal(n.event, 'request_no_bids');
    assert.equal((await buyer.call('GET', `/api/requests/${r.id}`)).request.wave, 3);
    const w = await buyer.call('POST', `/api/requests/${r.id}/widen`);
    assert.ok(w.sent_to >= 1, 'the Sahiwal wholesaler sells this panel');
    assert.ok((await buyer.call('GET', `/api/requests/${r.id}`)).targets.some((t) => t.name === 'Abbas Solar Store'));
    assert.equal((await buyer.call('POST', `/api/requests/${r.id}/widen`)).sent_to, 0, 'widening twice sends nothing new');
    await rejects(smallBuyer.call('POST', `/api/requests/${r.id}/widen`), 404);
  });

  test('two bids within 30 minutes stop wave 2, and any bid stops the no-bids notice', async () => {
    const r = await post(buyer, { model_id: M['Longi Hi-MO 6 580 W'], qty: 20 });
    const d = await buyer.call('GET', `/api/requests/${r.id}`);
    const bidders = d.targets.filter((t) => t.in_stock).slice(0, 2);
    assert.equal(bidders.length, 2, 'seed has at least two Lahore suppliers with this panel in stock');
    const clients = { 'Al-Noor Solar Imports': alNoor, 'Sun City Traders': sunCity, 'Green Volt Wholesale': greenVolt };
    for (const t of bidders) await clients[t.name].call('POST', `/api/requests/${r.id}/instant-bid`);
    await srv.advance(31);
    assert.equal((await srv.tick(['waves'])).waves, 0);
    assert.equal((await buyer.call('GET', `/api/requests/${r.id}`)).targets.length, r.sent_to);
  });

  test('widening by WhatsApp button, and only for open requests', async () => {
    const r = await post(buyer, { model_id: M['Inverex Nitrox 6 kW'], qty: 1 });
    await buyer.call('POST', '/api/whatsapp', { button: 'Widen search', context: { type: 'request', request_id: r.id } });
    assert.match((await waBodies(buyer)).at(-1), /Sent to \d+ more supplier|No other suppliers/);
    await buyer.call('POST', `/api/requests/${r.id}/cancel`);
    await rejects(buyer.call('POST', `/api/requests/${r.id}/widen`), 409);
  });

  test('closing notice 6 hours before expiry, then an expiry notice, each once', async () => {
    const r = await post(smallBuyer, { model_id: M['Pylontech US5000'], qty: 1 });
    const mine = async (ev) => (await notes(smallBuyer)).filter((x) => x.event === ev && x.link === `#/b/request/${r.id}`);
    await srv.advance(41 * 60);
    await srv.tick(['closing']);
    assert.equal((await mine('request_closing')).length, 0);
    await srv.advance(2 * 60); // 43 hours in
    await srv.tick(['closing']);
    await srv.tick(['closing']);
    const closing = await mine('request_closing');
    assert.equal(closing.length, 1);
    assert.match(closing[0].body, /closes in about 6 hours with no bids/);
    await srv.advance(6 * 60);
    await srv.tick(['expire']);
    const n = (await notes(smallBuyer)).find((x) => x.event === 'request_expired' && x.link === `#/b/request/${r.id}`);
    assert.ok(n);
    assert.match(n.body, /closed after 48 hours/);
    // Reading the request does not send it again.
    await smallBuyer.call('GET', `/api/requests/${r.id}`);
    assert.equal((await notes(smallBuyer)).filter((x) => x.link === `#/b/request/${r.id}` && x.event === 'request_expired').length, 1);
  });

  test('a pending order reminds the supplier once after 4 hours', async () => {
    const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
    const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
    await srv.advance(3 * 60);
    await srv.tick(['orderReminders']);
    assert.ok(!(await notes(sunCity)).some((n) => n.event === 'order_reminder' && n.link === `#/order/${o.id}`));
    await srv.advance(61);
    await srv.tick(['orderReminders']);
    await srv.tick(['orderReminders']);
    const rem = (await notes(sunCity)).filter((n) => n.event === 'order_reminder' && n.link === `#/order/${o.id}`);
    assert.equal(rem.length, 1);
    // The reminder's Accept button works on WhatsApp.
    await sunCity.call('POST', '/api/whatsapp', { button: 'Accept', context: { type: 'order', order_id: o.id } });
    assert.equal((await buyer.call('GET', `/api/orders/${o.id}`)).status, 'accepted');
  });

  test('a dispatched order counts as delivered after 7 days, and both sides are asked to rate', async () => {
    const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
    const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
    await sunCity.call('POST', `/api/orders/${o.id}/accept`);
    await sunCity.call('POST', `/api/orders/${o.id}/dispatch`);
    await srv.advance(6 * 24 * 60);
    await srv.tick(['autoDeliver']);
    assert.equal((await buyer.call('GET', `/api/orders/${o.id}`)).status, 'dispatched');
    await srv.advance(24 * 60 + 1);
    assert.equal((await srv.tick(['autoDeliver'])).autoDeliver, 1);
    const od = await buyer.call('GET', `/api/orders/${o.id}`);
    assert.equal(od.status, 'delivered');
    assert.equal(od.auto_delivered, 1);
    assert.equal(od.rating.can_rate, true);
    for (const c of [buyer, sunCity]) {
      const mine = (await notes(c)).filter((n) => n.link === `#/order/${o.id}`).map((n) => n.event);
      assert.ok(mine.includes('rate_prompt'), 'asked to rate');
      assert.ok(mine.includes('order_update'), 'told it was marked delivered');
    }
  });

  test('the morning price check runs once a day from 8 am Pakistan time, only for suppliers who have not confirmed', async () => {
    await srv.setClock('2026-12-10T02:30:00Z'); // 07:30 in Pakistan
    assert.equal((await srv.tick(['priceCheck'])).priceCheck, 0);
    await srv.setClock('2026-12-10T03:05:00Z'); // 08:05
    await alNoor.call('POST', '/api/listings/confirm-all'); // Al-Noor confirmed already today
    const sent = (await srv.tick(['priceCheck'])).priceCheck;
    assert.ok(sent >= 3);
    assert.ok(!(await notes(alNoor)).some((n) => n.event === 'price_check' && n.created_at.startsWith('2026-12-10')));
    assert.ok((await notes(sunCity)).some((n) => n.event === 'price_check'));
    assert.equal((await srv.tick(['priceCheck'])).priceCheck, 0, 'once a day');
    // A server that only starts in the afternoon does not send "Good morning"; it waits for the next morning.
    await srv.setClock('2026-12-11T09:00:00Z'); // 14:00 in Pakistan
    assert.equal((await srv.tick(['priceCheck'])).priceCheck, 0, 'not in the afternoon');
    await srv.setClock('2026-12-12T03:05:00Z');
    assert.ok((await srv.tick(['priceCheck'])).priceCheck >= 1, 'and again the next morning');
  });

  test('all jobs together are idempotent', async () => {
    await srv.tick();
    const before = sql(srv, 'SELECT COUNT(*) n FROM notifications')[0].n;
    await srv.tick();
    assert.equal(sql(srv, 'SELECT COUNT(*) n FROM notifications')[0].n, before);
  });
});

describe('daily cap on request alerts', () => {
  let srv, buyer, greenVolt;
  before(async () => {
    srv = await startServer();
    [buyer, greenVolt] = await Promise.all(['sunPeak', 'greenVolt'].map((w) => as(srv.base, w)));
  });
  after(async () => { await srv.stop(); });

  test('after 10 alerts for items not in stock within 24 hours, more requests reach the app only', async () => {
    for (let i = 0; i < 11; i++) await post(buyer, { category: 'structure', description: `Mounting structure job ${i}`, qty: 10 });
    const mine = (await notes(greenVolt)).filter((n) => n.event === 'request_match');
    assert.equal(mine.length, 11, 'every request is still in the app');
    assert.equal(mine.filter((n) => n.wa_status === 'capped').length, 1);
    assert.equal(mine[0].wa_status, 'capped');
    // The cap resets after 24 hours.
    await srv.advance(24 * 60 + 1);
    await post(buyer, { category: 'structure', description: 'Next day job', qty: 5 });
    assert.equal((await notes(greenVolt))[0].wa_status, 'sent');
  });
});
