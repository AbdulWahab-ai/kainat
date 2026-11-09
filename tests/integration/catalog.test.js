// Catalogue, search, comparing offers, price privacy and supplier profiles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rejects, as } from '../helpers/server.js';

let srv, verified, unverified, partner, sup, admin;
before(async () => {
  srv = await startServer();
  verified = await as(srv.base, 'sunPeak');      // verified buyer
  unverified = await as(srv.base, 'brightWorks'); // not verified, 1 past deal with Sun City
  partner = unverified;
  sup = await as(srv.base, 'alNoor');
  admin = await as(srv.base, 'admin');
});
after(async () => { await srv.stop(); });

const spf = async (c) => (await c.call('GET', '/api/catalog?q=SPF 10000'))[0];

test('catalogue search matches every word, any order, any case', async () => {
  assert.equal((await verified.call('GET', '/api/catalog?q=growatt spf 10000')).length, 1);
  assert.equal((await verified.call('GET', '/api/catalog?q=10000 GROWATT')).length, 1);
  assert.equal((await verified.call('GET', '/api/catalog?q=zzz')).length, 0);
  const batteries = await verified.call('GET', '/api/catalog?category=battery');
  assert.ok(batteries.length >= 4 && batteries.every((m) => m.category === 'battery'));
  assert.ok((await verified.call('GET', '/api/catalog')).length <= 50);
});

test('submitting a model validates input, reuses duplicates, and stays private until approved', async () => {
  await rejects(sup.call('POST', '/api/models', { category: 'rocket', brand: 'X', name: 'Y' }), 400, /category/);
  await rejects(sup.call('POST', '/api/models', { category: 'battery', brand: '', name: 'Y' }), 400, /brand/);
  await rejects(sup.call('POST', '/api/models', { category: 'battery', brand: 'X', name: ' ' }), 400, /model name/);
  const dup = await sup.call('POST', '/api/models', { category: 'battery', brand: 'pylontech', name: 'us5000' });
  assert.equal(dup.status, 'approved', 'case-insensitive duplicate returns the existing model');
  const m = await sup.call('POST', '/api/models', { category: 'inverter', brand: 'Solis', name: 'S6 8K Hybrid', specs: '8 kW' });
  assert.equal(m.status, 'pending');
  assert.ok((await sup.call('GET', '/api/catalog?q=Solis')).some((x) => x.id === m.id), 'submitter sees it');
  assert.ok(!(await verified.call('GET', '/api/catalog?q=Solis')).some((x) => x.id === m.id), 'others do not');
  const am = await admin.call('POST', '/api/models', { category: 'cable', brand: 'Fast', name: 'AC 10mm' });
  assert.equal(am.status, 'approved', 'admin-added models are approved straight away');
});

test('search filters by category, city and stock', async () => {
  const all = await verified.call('GET', '/api/search?instock=1&city=Lahore');
  assert.ok(all.length > 5 && all.every((r) => r.suppliers > 0));
  const inv = await verified.call('GET', '/api/search?category=inverter&instock=1&city=Lahore');
  assert.ok(inv.length > 0 && inv.every((r) => r.model.category === 'inverter'));
  const sahiwal = await verified.call('GET', '/api/search?q=longi&city=Sahiwal');
  assert.equal(sahiwal[0].suppliers, 1, 'only the Sahiwal wholesaler delivers to Sahiwal');
  const noMatch = await verified.call('GET', '/api/search?q=unicorn');
  assert.equal(noMatch.length, 0);
  const us5000Stock = (await verified.call('GET', '/api/search?q=US5000&instock=1&city=Lahore'))[0];
  const us5000Any = (await verified.call('GET', '/api/search?q=US5000&instock=0&city=Lahore'))[0];
  assert.ok(us5000Any.suppliers >= us5000Stock.suppliers);
});

test('a verified buyer sees exact prices; an unverified one sees ranges except from past partners', async () => {
  const m = await spf(verified);
  const v = (await verified.call('GET', `/api/models/${m.id}/offers?city=Lahore`)).offers;
  assert.ok(v.every((o) => o.exact && typeof o.price === 'number'));
  const u = (await unverified.call('GET', `/api/models/${m.id}/offers?city=Lahore`)).offers;
  const alNoor = u.find((o) => o.supplier.name === 'Al-Noor Solar Imports');
  assert.equal(alNoor.exact, false);
  assert.equal(alNoor.price, undefined, 'the exact price never leaves the server');
  assert.ok(alNoor.low < alNoor.high);
  const sunCity = u.find((o) => o.supplier.name === 'Sun City Traders');
  assert.equal(sunCity.exact, true, 'Sun City lists exact prices publicly');
  assert.equal(sunCity.supplier.with_you, 1, 'and is a past partner');
});

test('offers are ranked: fresh, in stock, then cheapest', async () => {
  const m = await spf(verified);
  const offers = (await verified.call('GET', `/api/models/${m.id}/offers`)).offers;
  const prices = offers.filter((o) => o.stale_days <= 3 && o.qty > 0).map((o) => o.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('unknown model or listing returns 404', async () => {
  await rejects(verified.call('GET', '/api/models/99999/offers'), 404);
  await rejects(verified.call('GET', '/api/listings/99999'), 404);
  await rejects(verified.call('GET', '/api/models/abc/offers'), 404);
});

test('a single listing hides the exact price from buyers who should see a range', async () => {
  const offers = (await unverified.call('GET', `/api/models/${(await spf(verified)).id}/offers`)).offers;
  const id = offers.find((o) => o.supplier.name === 'Al-Noor Solar Imports').id;
  const l = await unverified.call('GET', `/api/listings/${id}`);
  assert.equal(l.price, undefined);
  assert.equal(l.exact, false);
  assert.equal((await verified.call('GET', `/api/listings/${id}`)).price, 325000);
});

test('supplier profile hides contact details until there is an order, and shows history with this buyer', async () => {
  const alNoor = await unverified.call('GET', '/api/suppliers/2');
  assert.equal(alNoor.supplier.phone, undefined);
  assert.equal(alNoor.supplier.address, undefined);
  assert.equal(alNoor.history.length, 0);
  assert.ok(alNoor.items.every((i) => i.price === undefined || i.visibility === 'exact'));
  const forPartner = await verified.call('GET', '/api/suppliers/2');
  assert.ok(forPartner.supplier.phone, 'SunPeak traded with Al-Noor, so contact shows');
  assert.equal(forPartner.history.length, 3);
  await rejects(verified.call('GET', '/api/suppliers/8'), 404, /Supplier not found/); // id 8 is a buyer
  await rejects(verified.call('GET', '/api/suppliers/99999'), 404);
});

test('a buyer cannot read another buyer\'s quote', async () => {
  const mine = await verified.call('GET', '/api/requests');
  const r = await verified.call('GET', `/api/requests/${mine[0].id}`);
  const qid = r.quotes[0].id;
  assert.equal((await verified.call('GET', `/api/quotes/${qid}`)).id, qid);
  await rejects(partner.call('GET', `/api/quotes/${qid}`), 403);
  await rejects(verified.call('GET', '/api/quotes/99999'), 404);
});

test('ordering a listing the buyer can only see as a range is refused', async () => {
  const offers = (await unverified.call('GET', `/api/models/${(await spf(verified)).id}/offers`)).offers;
  const id = offers.find((o) => o.supplier.name === 'Al-Noor Solar Imports').id;
  await rejects(unverified.call('POST', '/api/orders', { listing_id: id, qty: 1, address: 'Model Town, Lahore' }), 403, /exact price/);
});
