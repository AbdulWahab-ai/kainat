// Supplier shop management and every simulated WhatsApp conversation path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rejects, as } from '../helpers/server.js';

let srv, buyer, alNoor, sunCity, abbas, M;
before(async () => {
  srv = await startServer();
  [buyer, alNoor, sunCity, abbas] = await Promise.all(['sunPeak', 'alNoor', 'sunCity', 'abbas'].map((w) => as(srv.base, w)));
  M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
});
after(async () => { await srv.stop(); });

const lastWa = async (c) => (await c.call('GET', '/api/whatsapp')).at(-1);
const send = (c, body) => c.call('POST', '/api/whatsapp', body);

// ---------- shop ----------
test('shop lists only the supplier\'s own items with freshness and price range', async () => {
  const shop = await alNoor.call('GET', '/api/shop');
  assert.equal(shop.length, 5);
  assert.ok(shop.every((l) => l.supplier_id === 2 && typeof l.stale_days === 'number' && l.band.length === 2));
});

test('adding an item: validation, duplicates and price history', async () => {
  await rejects(abbas.call('POST', '/api/listings', { price: 1000 }), 400, /model/);
  await rejects(abbas.call('POST', '/api/listings', { model_id: 99999, price: 1000 }), 400);
  await rejects(abbas.call('POST', '/api/listings', { model_id: M['Dyness B4850'], price: 0 }), 400, /price/);
  await rejects(abbas.call('POST', '/api/listings', { model_id: M['Dyness B4850'], price: -5 }), 400);
  const { id } = await abbas.call('POST', '/api/listings', { model_id: M['Dyness B4850'], price: '1,10,000', qty: -4, min_order: 0, token_pct: 300, visibility: 'exact' });
  const l = (await abbas.call('GET', '/api/shop')).find((x) => x.id === id);
  assert.deepEqual([l.price, l.qty, l.min_order, l.token_pct, l.visibility, l.source], [110000, 0, 1, 100, 'exact', 'manual']);
  await rejects(abbas.call('POST', '/api/listings', { model_id: M['Dyness B4850'], price: 1 }), 409, /already in your shop/);
  assert.equal((await abbas.call('GET', `/api/listings/${id}/history`)).length, 1);
});

test('editing an item: only your own, price history on change, partial updates keep other fields', async () => {
  const l = (await alNoor.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  await rejects(sunCity.call('PUT', `/api/listings/${l.id}`, { price: 1 }), 404);
  await rejects(alNoor.call('PUT', `/api/listings/${l.id}`, { price: 0 }), 400);
  await alNoor.call('PUT', `/api/listings/${l.id}`, { price: 17100 });
  await alNoor.call('PUT', `/api/listings/${l.id}`, { price: 17100 });
  const h = await alNoor.call('GET', `/api/listings/${l.id}/history`);
  assert.equal(h[0].price, 17100);
  assert.equal(h.length, 2, 'an unchanged price adds no history');
  await alNoor.call('PUT', `/api/listings/${l.id}`, { visibility: 'sideways', qty: '' });
  const after = (await alNoor.call('GET', '/api/shop')).find((x) => x.id === l.id);
  assert.equal(after.visibility, l.visibility, 'invalid visibility is ignored');
  assert.equal(after.qty, l.qty, 'blank quantity keeps the old one');
  await alNoor.call('PUT', `/api/listings/${l.id}`, { visible: false });
  assert.equal((await alNoor.call('GET', '/api/shop')).find((x) => x.id === l.id).visible, 0);
  await alNoor.call('PUT', `/api/listings/${l.id}`, { visible: true });
  await rejects(sunCity.call('GET', `/api/listings/${l.id}/history`), 404);
});

test('confirm-all marks every visible price confirmed today', async () => {
  const r = await alNoor.call('POST', '/api/listings/confirm-all');
  assert.ok(r.confirmed >= 4);
  assert.equal((await alNoor.me()).counts.unconfirmed_today, 0);
});

// ---------- WhatsApp ----------
test('an empty WhatsApp message is rejected', async () => {
  await rejects(send(alNoor, {}), 400);
  await rejects(send(alNoor, { text: '   ' }), 400);
});

test('"Send price" then a typed price creates a quote and offers to add it to the shop', async () => {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Inverex Nitrox 6 kW'], qty: 2, city: 'Lahore' });
  const msg = (await sunCity.call('GET', '/api/whatsapp')).filter((m) => m.context?.request_id === r.id).at(-1);
  assert.ok(msg.buttons[0].startsWith('Bid Rs'), 'Sun City has Nitrox in stock, so it gets the one-tap bid');
  await send(sunCity, { button: 'Bid lower', context: msg.context });
  assert.match((await lastWa(sunCity)).body, /Type your price/);
  await send(sunCity, { text: '1.65 lakh 4 25' });
  const ask = await lastWa(sunCity);
  assert.deepEqual(ask.buttons, ['Yes, add it', 'Only this buyer']);
  await send(sunCity, { button: 'Only this buyer', context: ask.context });
  assert.match((await lastWa(sunCity)).body, /only this buyer/);
  const q = (await buyer.call('GET', `/api/requests/${r.id}`)).quotes[0];
  assert.deepEqual([q.price, q.qty, q.token_pct, q.channel, q.share], [165000, 4, 25, 'whatsapp', 0]);
  const shopPrice = (await sunCity.call('GET', '/api/shop')).find((l) => l.name === 'Nitrox 6 kW').price;
  assert.notEqual(shopPrice, 165000, 'not added to the shop');
  await send(sunCity, { button: 'Yes, add it', context: ask.context });
  assert.equal((await sunCity.call('GET', '/api/shop')).find((l) => l.name === 'Nitrox 6 kW').price, 165000);
});

test('the one-tap "Bid Rs …" button places a bid at the shop price and reports the rank', async () => {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
  const msg = (await alNoor.call('GET', '/api/whatsapp')).filter((m) => m.context?.request_id === r.id).at(-1);
  await send(alNoor, { button: msg.buttons[0], context: msg.context });
  const reply = await lastWa(alNoor);
  assert.match(reply.body, /Bid placed/);
  assert.match(reply.body, /#1 of 1/);
  assert.deepEqual(reply.buttons, ['Lower my bid']);
});

test('"Not in stock" passes on the request', async () => {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
  await send(sunCity, { button: 'Not in stock', context: { type: 'request', request_id: r.id } });
  assert.equal((await sunCity.call('GET', '/api/requests')).find((x) => x.id === r.id).target_status, 'passed');
});

test('a price typed with no open request gets a help reply, not a crash', async () => {
  await send(abbas, { text: 'Assalam o Alaikum' });
  assert.match((await lastWa(abbas)).body, /To quote, reply to a request/);
  await send(buyer, { text: '12345' });
  assert.match((await lastWa(buyer)).body, /Open the app/);
});

test('a WhatsApp reply to a closed request says it closed', async () => {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
  await send(sunCity, { button: 'Send price', context: { type: 'request', request_id: r.id } });
  await buyer.call('POST', `/api/requests/${r.id}/cancel`);
  await send(sunCity, { text: '300000' });
  assert.match((await lastWa(sunCity)).body, /closed/);
  await send(sunCity, { button: 'Bid Rs 1', context: { type: 'request', request_id: r.id } });
  assert.match((await lastWa(sunCity)).body, /closed/);
});

test('accepting and declining an order from WhatsApp, including the decline reason', async () => {
  const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  const o1 = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
  await send(sunCity, { button: 'Accept', context: { type: 'order', order_id: o1.id } });
  assert.equal((await buyer.call('GET', `/api/orders/${o1.id}`)).status, 'accepted');
  await send(sunCity, { button: 'Accept', context: { type: 'order', order_id: o1.id } });
  assert.match((await lastWa(sunCity)).body, /already accepted/);
  const o2 = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
  await send(sunCity, { button: 'Decline', context: { type: 'order', order_id: o2.id } });
  assert.match((await lastWa(sunCity)).body, /Why are you declining/);
  await send(sunCity, { text: 'Out of stock until Monday' });
  const d = await buyer.call('GET', `/api/orders/${o2.id}`);
  assert.equal(d.status, 'declined');
  assert.equal(d.decline_reason, 'Out of stock until Monday');
  await send(alNoor, { button: 'Accept', context: { type: 'order', order_id: o1.id } });
  assert.match((await lastWa(alNoor)).body, /not found/, 'another supplier cannot accept it');
});

test('the morning price check: "Yes, same" confirms, "Change some" points to the shop', async () => {
  await send(abbas, { button: 'Yes, same', context: { type: 'pricecheck' } });
  assert.match((await lastWa(abbas)).body, /prices confirmed/);
  await send(abbas, { button: 'Change some', context: { type: 'pricecheck' } });
  assert.deepEqual((await lastWa(abbas)).buttons, ['Open my shop']);
});

test('an unknown button gets a safe reply', async () => {
  await send(abbas, { button: 'Do a backflip' });
  assert.match((await lastWa(abbas)).body, /Open the app/);
});

test('WhatsApp history is private and newest last', async () => {
  const mine = await alNoor.call('GET', '/api/whatsapp');
  assert.ok(mine.every((m) => m.business_id === 2));
  assert.ok(mine.length <= 80);
  const ids = mine.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});
