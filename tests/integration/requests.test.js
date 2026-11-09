// Buyer requests, supplier matching, quotes, instant bids, open and sealed bidding, expiry and invites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rejects, as } from '../helpers/server.js';

let srv, buyer, smallBuyer, alNoor, sunCity, greenVolt, bright, abbas, admin, M;
before(async () => {
  srv = await startServer();
  [buyer, smallBuyer, alNoor, sunCity, greenVolt, bright, abbas, admin] = await Promise.all(
    ['sunPeak', 'brightWorks', 'alNoor', 'sunCity', 'greenVolt', 'bright', 'abbas', 'admin'].map((w) => as(srv.base, w)));
  const cat = await buyer.call('GET', '/api/catalog');
  M = Object.fromEntries(cat.map((m) => [`${m.brand} ${m.name}`, m.id]));
});
after(async () => { await srv.stop(); });

const post = (c, body) => c.call('POST', '/api/requests', { city: 'Lahore', scope: 'all', ...body });

test('request validation', async () => {
  await rejects(post(buyer, { qty: 1 }), 400, /model or a category/);
  await rejects(post(buyer, { category: 'battery', qty: 1 }), 400, /Describe what you need/);
  await rejects(post(buyer, { model_id: 99999, qty: 1 }), 404);
  await rejects(post(buyer, { listing_id: 99999, qty: 1 }), 404);
  for (const qty of [0, -2, 'abc', '', '   ']) await rejects(post(buyer, { model_id: M['Pylontech US5000'], qty }), 400, /quantity/);
  await rejects(post(buyer, { category: 'spaceship', description: 'x', qty: 1 }), 400);
});

test('an empty city falls back to the buyer\'s own city', async () => {
  const r = await post(buyer, { model_id: M['Longi Hi-MO 6 580 W'], qty: 10, city: '  ' });
  assert.equal((await buyer.call('GET', `/api/requests/${r.id}`)).request.city, 'Lahore');
});

test('matching sends a Lahore request only to suppliers that sell the category and deliver to Lahore', async () => {
  const r = await post(buyer, { model_id: M['Pylontech US3000C'], qty: 2 });
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  const names = d.targets.map((t) => t.name);
  assert.ok(names.includes('Sun City Traders'));
  assert.ok(!names.includes('Abbas Solar Store'), 'Sahiwal wholesaler does not deliver to Lahore');
  assert.ok(!names.includes('Green Volt Wholesale'), 'Green Volt sells no batteries');
  assert.equal(r.sent_to, d.targets.length);
});

test('a Sahiwal request reaches the Sahiwal wholesaler', async () => {
  const r = await post(buyer, { model_id: M['Longi Hi-MO 6 580 W'], qty: 20, city: 'Okara' });
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  assert.deepEqual(d.targets.map((t) => t.name), ['Abbas Solar Store']);
});

test('"partners only" goes only to suppliers the buyer has traded with', async () => {
  const r = await post(smallBuyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1, scope: 'partners' });
  const d = await smallBuyer.call('GET', `/api/requests/${r.id}`);
  assert.deepEqual(d.targets.map((t) => t.name), ['Sun City Traders']);
});

test('asking one listing for its exact price goes to that supplier only', async () => {
  const offers = (await smallBuyer.call('GET', `/api/models/${M['Growatt SPF 10000 ES']}/offers`)).offers;
  const l = offers.find((o) => o.supplier.name === 'Al-Noor Solar Imports');
  const r = await post(smallBuyer, { listing_id: l.id, qty: 2 });
  const d = await smallBuyer.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.request.scope, 'listing');
  assert.deepEqual(d.targets.map((t) => t.name), ['Al-Noor Solar Imports']);
});

test('a free-text request reaches category suppliers, and the quote names a model', async () => {
  const r = await post(buyer, { category: 'battery', description: '5 kWh lithium battery', qty: 3 });
  assert.ok(r.sent_to >= 2);
  assert.equal(r.in_stock, 0, 'no model means no exact stock match');
  await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 300000, qty: 3, model_id: M['Pylontech US5000'], share: true });
  const q = (await buyer.call('GET', `/api/requests/${r.id}`)).quotes[0];
  assert.equal(q.model.name, 'US5000');
});

test('in-stock suppliers are flagged with their stock and price, others are not', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 2 });
  assert.equal(r.in_stock, 4);
  const row = (await alNoor.call('GET', '/api/requests')).find((x) => x.id === r.id);
  assert.deepEqual([row.in_stock.in_stock, row.in_stock.stock_price], [1, 325000]);
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.in_stock.length, 4, 'buyer sees four in-stock suppliers before any bid');
  assert.equal(d.targets.filter((t) => t.in_stock === 1).length, 4);
  const noStock = d.targets.find((t) => t.name === 'New Era Energy');
  assert.equal(noStock?.in_stock, 0, 'a supplier that sells inverters but not this model gets the request without the stock flag');
});

test('quote validation and permissions', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 2 });
  await rejects(abbas.call('POST', `/api/requests/${r.id}/quote`, { price: 1000 }), 403, /not sent to you/);
  for (const price of [undefined, 0, -100, 'abc', '']) await rejects(alNoor.call('POST', `/api/requests/${r.id}/quote`, { price, qty: 1 }), 400, /price/);
  await rejects(alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 1000, qty: -1 }), 400, /quantity/);
  await rejects(alNoor.call('POST', '/api/requests/99999/quote', { price: 1000 }), 404);
  const q = await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: '3,20,000', qty: '', token_pct: 250, lead_days: -3, visibility: 'weird' });
  assert.equal(q.price, 320000);
  assert.equal(q.qty, 2, 'blank quantity defaults to the requested quantity');
  assert.equal(q.token_pct, 100, 'token is capped at 100%');
  assert.equal(q.lead_days, 0);
  assert.equal(q.visibility, 'band');
});

test('a shared quote updates the shop; an unshared one does not', async () => {
  const r = await post(buyer, { model_id: M['Narada 51.2V 100Ah'], qty: 1 });
  const target = (await buyer.call('GET', `/api/requests/${r.id}`)).targets.map((t) => t.name);
  assert.ok(target.includes('Al-Noor Solar Imports'));
  await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 260000, qty: 5, share: false });
  assert.ok(!(await alNoor.call('GET', '/api/shop')).some((l) => l.name === '51.2V 100Ah'));
  await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 259000, qty: 5, share: true, visibility: 'exact' });
  const l = (await alNoor.call('GET', '/api/shop')).find((x) => x.name === '51.2V 100Ah');
  assert.equal(l.price, 259000);
  assert.equal(l.source, 'quote');
  assert.equal(l.visibility, 'exact');
});

test('instant bid uses the shop price and fails without stock', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 3 });
  const shopPrice = (await alNoor.call('GET', '/api/shop')).find((l) => l.name === 'SPF 10000 ES').price;
  const x = await alNoor.call('POST', `/api/requests/${r.id}/instant-bid`);
  assert.equal(x.quote.price, shopPrice);
  assert.equal(x.board.my_rank, 1);
  const r2 = await post(buyer, { model_id: M['Dyness B4850'], qty: 1 });
  await rejects(alNoor.call('POST', `/api/requests/${r2.id}/instant-bid`), 409, /not in stock/);
  await rejects(abbas.call('POST', `/api/requests/${r.id}/instant-bid`), 409);
  await rejects(alNoor.call('POST', '/api/requests/99999/instant-bid'), 404);
});

test('open bidding: ranks, lowest price, outbid alert and revisions', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 3, bidding: 'open' });
  await greenVolt.call('POST', `/api/requests/${r.id}/quote`, { price: 330000, qty: 10 });
  await sunCity.call('POST', `/api/requests/${r.id}/quote`, { price: 327000, qty: 6 });
  const gvAlert = (await greenVolt.call('GET', '/api/whatsapp')).at(-1);
  assert.match(gvAlert.body, /outbid/);
  assert.match(gvAlert.body, /327,000|3,27,000/);
  const gv = await greenVolt.call('GET', `/api/requests/${r.id}/board`);
  assert.deepEqual([gv.count, gv.my_rank, gv.lowest, gv.mode], [2, 2, 327000, 'open']);
  await greenVolt.call('POST', `/api/requests/${r.id}/quote`, { price: 326000, qty: 10 });
  assert.equal((await greenVolt.call('GET', `/api/requests/${r.id}/board`)).my_rank, 1);
  // Bidding the same price again is not a revision and alerts no one.
  const before = (await sunCity.call('GET', '/api/whatsapp')).length;
  await greenVolt.call('POST', `/api/requests/${r.id}/quote`, { price: 326000, qty: 10 });
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  const q = d.quotes.find((x) => x.supplier.name === 'Green Volt Wholesale');
  assert.equal(q.revisions, 2);
  assert.equal(q.first_price, 330000);
  assert.ok((await sunCity.call('GET', '/api/whatsapp')).length >= before);
  assert.deepEqual(d.quotes.map((x) => x.price), [...d.quotes.map((x) => x.price)].sort((a, b) => a - b), 'buyer sees lowest first');
});

test('sealed bidding hides the lowest bid and sends no outbid alerts', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1, bidding: 'sealed' });
  await greenVolt.call('POST', `/api/requests/${r.id}/quote`, { price: 330000, qty: 1 });
  const before = (await greenVolt.call('GET', '/api/whatsapp')).length;
  await sunCity.call('POST', `/api/requests/${r.id}/quote`, { price: 300000, qty: 1 });
  const gv = await greenVolt.call('GET', `/api/requests/${r.id}/board`);
  assert.equal(gv.mode, 'sealed');
  assert.equal(gv.lowest, undefined);
  assert.equal(gv.my_price, 330000);
  const after = await greenVolt.call('GET', '/api/whatsapp');
  assert.equal(after.filter((m) => /outbid/.test(m.body)).length, (await greenVolt.call('GET', '/api/whatsapp')).filter((m) => /outbid/.test(m.body)).length);
  assert.ok(!after.slice(before).some((m) => /outbid/.test(m.body)));
  const rows = await greenVolt.call('GET', '/api/requests');
  assert.equal(rows.find((x) => x.id === r.id).board.lowest, undefined, 'inbox does not leak it either');
  const any = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1, bidding: 'anything' });
  assert.equal((await buyer.call('GET', `/api/requests/${any.id}`)).request.bidding, 'open');
});

test('board access is limited to the buyer and targeted suppliers', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  await rejects(abbas.call('GET', `/api/requests/${r.id}/board`), 403);
  await rejects(smallBuyer.call('GET', `/api/requests/${r.id}/board`), 403);
  await rejects(buyer.call('GET', '/api/requests/99999/board'), 404);
  assert.equal(typeof (await buyer.call('GET', `/api/requests/${r.id}/board`)).latest, 'number');
});

test('request detail is private to the buyer, targeted suppliers and admins', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  await rejects(smallBuyer.call('GET', `/api/requests/${r.id}`), 403);
  await rejects(abbas.call('GET', `/api/requests/${r.id}`), 403);
  assert.equal((await alNoor.call('GET', `/api/requests/${r.id}`)).request.id, r.id);
  assert.equal((await admin.call('GET', `/api/requests/${r.id}`)).request.id, r.id);
  await rejects(buyer.call('GET', '/api/requests/99999'), 404);
});

test('passing on a request', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  await alNoor.call('POST', `/api/requests/${r.id}/pass`);
  assert.equal((await alNoor.call('GET', '/api/requests')).find((x) => x.id === r.id).target_status, 'passed');
  await rejects(abbas.call('POST', `/api/requests/${r.id}/pass`), 404);
});

test('cancel: only the owner, only while open, and no quotes after', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  await rejects(smallBuyer.call('POST', `/api/requests/${r.id}/cancel`), 404);
  await buyer.call('POST', `/api/requests/${r.id}/cancel`);
  await rejects(buyer.call('POST', `/api/requests/${r.id}/cancel`), 409);
  await rejects(alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 1, qty: 1 }), 409, /no longer open/);
});

test('requests expire after their deadline and cannot be quoted or ordered', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  await sunCity.call('POST', `/api/requests/${r.id}/quote`, { price: 320000, qty: 1 });
  const db = srv.db();
  db.prepare('UPDATE requests SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), r.id);
  db.close();
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.request.status, 'expired');
  await rejects(alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 1, qty: 1 }), 409);
  await rejects(buyer.call('POST', '/api/orders', { quote_id: d.quotes[0].id, qty: 1, address: 'x' }), 409);
});

test('inviting a supplier: validation, new shop, existing supplier, no duplicate alerts', async () => {
  const r = await post(buyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  await rejects(buyer.call('POST', '/api/invite-supplier', { name: 'X', phone: '123' }), 400, /mobile number/);
  await rejects(buyer.call('POST', '/api/invite-supplier', { phone: '03017776666' }), 400, /business name/);
  await rejects(buyer.call('POST', '/api/invite-supplier', { name: 'Buyer', phone: '03212222222' }), 409, /buyer account/);
  const x = await buyer.call('POST', '/api/invite-supplier', { name: 'Invited Traders', phone: '0301 777 6666', city: 'Lahore', request_id: r.id });
  assert.equal(x.targeted, true);
  const again = await buyer.call('POST', '/api/invite-supplier', { name: 'Invited Traders', phone: '03017776666', request_id: r.id });
  assert.equal(again.supplier_id, x.supplier_id);
  assert.equal(again.targeted, false, 'already has the request');
  const existing = await buyer.call('POST', '/api/invite-supplier', { name: 'Abbas', phone: '03005555555', request_id: r.id });
  assert.equal(existing.targeted, true);
  const inv = await as(srv.base, '03017776666');
  const me = (await inv.me()).me;
  assert.equal(me.claimed, false);
  assert.equal(me.setup_by, 'invite');
  assert.ok((await inv.call('GET', '/api/requests')).some((q) => q.id === r.id));
  const other = await post(smallBuyer, { model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  const y = await buyer.call('POST', '/api/invite-supplier', { name: 'Invited Traders', phone: '03017776666', request_id: other.id });
  assert.equal(y.targeted, false, 'cannot attach someone else\'s request');
});

test('buyer and supplier request lists carry the right extras', async () => {
  const mine = await buyer.call('GET', '/api/requests');
  assert.ok(mine.every((r) => typeof r.quotes === 'number' && typeof r.sent_to === 'number'));
  const inbox = await alNoor.call('GET', '/api/requests');
  assert.ok(inbox.every((r) => r.board && r.buyer && 'my_quote' in r));
  assert.deepEqual(await admin.call('GET', '/api/requests'), []);
});
