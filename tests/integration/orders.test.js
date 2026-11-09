// Orders: creation from listings and quotes, the full status lifecycle, token proof, messages, disputes and access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rejects, as, PNG, PDF } from '../helpers/server.js';

let srv, buyer, other, sunCity, alNoor, greenVolt, admin, M, sunCityListing;
before(async () => {
  srv = await startServer();
  [buyer, other, sunCity, alNoor, greenVolt, admin] = await Promise.all(['sunPeak', 'greenRoof', 'sunCity', 'alNoor', 'greenVolt', 'admin'].map((w) => as(srv.base, w)));
  M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
  sunCityListing = (await sunCity.call('GET', '/api/shop')).find((l) => l.name === 'SPF 10000 ES');
});
after(async () => { await srv.stop(); });

const order = (body) => buyer.call('POST', '/api/orders', { qty: 1, address: 'Office 5, Johar Town, Lahore', ...body });

test('order validation', async () => {
  await rejects(buyer.call('POST', '/api/orders', { listing_id: sunCityListing.id, qty: 1 }), 400, /address/);
  await rejects(buyer.call('POST', '/api/orders', { listing_id: sunCityListing.id, address: 'x' }), 400, /quantity/);
  await rejects(order({ listing_id: sunCityListing.id, qty: 0 }), 400);
  await rejects(order({}), 400, /listing or a quote/);
  await rejects(order({ listing_id: 99999 }), 404);
  await rejects(order({ quote_id: 99999 }), 404);
  await rejects(order({ listing_id: sunCityListing.id, qty: sunCityListing.qty + 1 }), 400, /in stock/);
  const gv = (await greenVolt.call('GET', '/api/shop')).find((l) => l.min_order > 1);
  await rejects(order({ listing_id: gv.id, qty: gv.min_order - 1 }), 400, /Minimum order/);
});

test('token proof must be an image or PDF under 6 MB', async () => {
  await rejects(order({ listing_id: sunCityListing.id, token_proof: 'data:text/html;base64,PGgxPg==' }), 400, /image or PDF/);
  await rejects(order({ listing_id: sunCityListing.id, token_proof: 'not a data url' }), 400);
  const big = 'data:image/png;base64,' + Buffer.alloc(6.5 * 1024 * 1024).toString('base64');
  await rejects(order({ listing_id: sunCityListing.id, token_proof: big }), 400, /6 MB/);
});

test('a rejected order leaves nothing half-created', async () => {
  const before = (await buyer.call('GET', '/api/orders')).length;
  await rejects(order({ listing_id: sunCityListing.id, token_proof: 'data:image/gif;base64,R0lGOD' }), 400);
  assert.equal((await buyer.call('GET', '/api/orders')).length, before);
});

test('hidden listings and suspended suppliers cannot be ordered', async () => {
  const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Nitrox 6 kW');
  await sunCity.call('PUT', `/api/listings/${l.id}`, { visible: false });
  await rejects(order({ listing_id: l.id }), 404, /no longer listed/);
  await sunCity.call('PUT', `/api/listings/${l.id}`, { visible: true });
  await admin.call('PUT', '/api/admin/businesses/3', { status: 'suspended' });
  await rejects(order({ listing_id: l.id }), 409, /not active/);
  await admin.call('PUT', '/api/admin/businesses/3', { status: 'active' });
  await rejects(sunCity.call('GET', '/api/shop'), 401, /sign in/); // suspension ended Sun City's session
  sunCity = await as(srv.base, 'sunCity');
});

test('full lifecycle from a listing: pending, accepted, dispatched, delivered, with stock and trade counts updated', async () => {
  const sc = await as(srv.base, 'sunCity');
  const stockBefore = (await sc.call('GET', '/api/shop')).find((l) => l.id === sunCityListing.id).qty;
  const dealsBefore = (await buyer.me()).me.deals;
  const { id } = await order({ listing_id: sunCityListing.id, qty: 2, token_proof: PNG, note: 'Call site manager', needed_by: '2026-12-01', save_address: true, address_label: 'Site X', address: 'Site X, Lahore' });
  let o = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(o.status, 'pending');
  assert.equal(o.price, sunCityListing.price, 'price locked from the listing');
  assert.equal(o.total, o.price * 2);
  assert.equal(o.token_amount, Math.round(o.total * o.token_pct / 100));
  assert.equal(o.token_proof, true);
  assert.ok((await sc.call('GET', '/api/whatsapp')).at(-1).buttons.includes('Accept'));
  await rejects(sc.call('POST', `/api/orders/${id}/dispatch`), 409, /Accept the order/);
  await rejects(buyer.call('POST', `/api/orders/${id}/deliver`), 409);
  await rejects(alNoor.call('POST', `/api/orders/${id}/accept`), 403);
  await sc.call('POST', `/api/orders/${id}/accept`);
  await rejects(sc.call('POST', `/api/orders/${id}/accept`), 409);
  await rejects(sc.call('POST', `/api/orders/${id}/decline`, { reason: 'late' }), 409);
  await rejects(buyer.call('POST', `/api/orders/${id}/cancel`), 409);
  assert.equal((await sc.call('GET', '/api/shop')).find((l) => l.id === sunCityListing.id).qty, stockBefore - 2, 'stock goes down on accept');
  await sc.call('POST', `/api/orders/${id}/dispatch`);
  await rejects(sc.call('POST', `/api/orders/${id}/dispatch`), 409);
  await buyer.call('POST', `/api/orders/${id}/deliver`);
  await rejects(buyer.call('POST', `/api/orders/${id}/deliver`), 409);
  o = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(o.status, 'delivered');
  assert.ok(o.accepted_at && o.dispatched_at && o.delivered_at);
  assert.equal((await buyer.me()).me.deals, dealsBefore + 1);
  assert.ok((await buyer.call('GET', '/api/addresses')).some((a) => a.label === 'Site X'));
});

test('a buyer can confirm delivery straight from accepted, skipping dispatch', async () => {
  const { id } = await order({ listing_id: sunCityListing.id });
  await sunCity.call('POST', `/api/orders/${id}/accept`);
  await buyer.call('POST', `/api/orders/${id}/deliver`);
  const o = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(o.status, 'delivered');
  assert.ok(o.dispatched_at, 'dispatch time is filled in');
});

test('declining needs to come from the supplier and records a reason', async () => {
  const { id } = await order({ listing_id: sunCityListing.id });
  await rejects(alNoor.call('POST', `/api/orders/${id}/decline`, { reason: 'x' }), 403);
  await sunCity.call('POST', `/api/orders/${id}/decline`, {});
  const o = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(o.status, 'declined');
  assert.equal(o.decline_reason, 'No reason given');
});

test('the buyer can cancel only before the supplier accepts', async () => {
  const { id } = await order({ listing_id: sunCityListing.id });
  await rejects(other.call('POST', `/api/orders/${id}/cancel`), 403);
  await buyer.call('POST', `/api/orders/${id}/cancel`);
  assert.equal((await buyer.call('GET', `/api/orders/${id}`)).status, 'cancelled');
  await rejects(sunCity.call('POST', `/api/orders/${id}/accept`), 409);
});

async function newQuotedRequest() {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 2, city: 'Lahore' });
  await sunCity.call('POST', `/api/requests/${r.id}/quote`, { price: 321000, qty: 6, share: false });
  await greenVolt.call('POST', `/api/requests/${r.id}/quote`, { price: 333000, qty: 9, share: false });
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  return { r, quotes: d.quotes };
}

test('ordering from a quote locks its price and closes the request', async () => {
  const { r, quotes } = await newQuotedRequest();
  await rejects(order({ quote_id: quotes[0].id, qty: 99 }), 400, /quoted for/);
  await rejects(other.call('POST', '/api/orders', { quote_id: quotes[0].id, qty: 1, address: 'x' }), 403);
  const { id } = await order({ quote_id: quotes[0].id, qty: 2 });
  const o = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(o.price, 321000);
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.request.status, 'ordered');
  assert.deepEqual(d.quotes.map((q) => q.status).sort(), ['chosen', 'lost']);
  assert.equal(d.order.id, id);
  await rejects(order({ quote_id: quotes[1].id }), 409);
});

test('a declined quote order reopens the request so another bid can be chosen', async () => {
  const { r, quotes } = await newQuotedRequest();
  const { id } = await order({ quote_id: quotes[0].id });
  await sunCity.call('POST', `/api/orders/${id}/decline`, { reason: 'Sold out' });
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.request.status, 'open');
  assert.equal(d.quotes.find((q) => q.id === quotes[0].id).status, 'lost');
  assert.equal(d.quotes.find((q) => q.id === quotes[1].id).status, 'active');
  const second = await order({ quote_id: quotes[1].id });
  assert.ok(second.id);
});

test('a cancelled quote order also reopens the request', async () => {
  const { r, quotes } = await newQuotedRequest();
  const { id } = await order({ quote_id: quotes[0].id });
  await buyer.call('POST', `/api/orders/${id}/cancel`);
  const d = await buyer.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.request.status, 'open', 'buyer can still pick a bid after cancelling');
  assert.ok(d.quotes.some((q) => q.status === 'active'));
  await order({ quote_id: quotes[1].id });
});

test('token proof can be added later by the buyer only, and is served only to the two parties and admins', async () => {
  const { id } = await order({ listing_id: sunCityListing.id });
  const fetchProof = (c) => fetch(`${srv.base}/api/orders/${id}/proof`, { headers: { cookie: c.cookie } });
  assert.equal((await fetchProof(buyer)).status, 404);
  await rejects(other.call('POST', `/api/orders/${id}/proof`, { token_proof: PNG }), 403);
  await buyer.call('POST', `/api/orders/${id}/proof`, { token_proof: PDF });
  const res = await fetchProof(sunCity);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetchProof(admin)).status, 200);
  assert.equal((await fetchProof(other)).status, 403);
  assert.equal((await fetchProof(alNoor)).status, 403);
});

test('order messages and problem flags', async () => {
  const { id } = await order({ listing_id: sunCityListing.id });
  await rejects(buyer.call('POST', `/api/orders/${id}/messages`, { body: '   ' }), 400);
  await rejects(other.call('POST', `/api/orders/${id}/messages`, { body: 'hi' }), 403);
  await buyer.call('POST', `/api/orders/${id}/messages`, { body: '<script>alert(1)</script>' });
  await sunCity.call('POST', `/api/orders/${id}/messages`, { body: 'Noted' });
  assert.match((await buyer.call('GET', '/api/whatsapp')).at(-1).body, /Noted/);
  await rejects(buyer.call('POST', `/api/orders/${id}/flag`, {}), 400, /Describe/);
  await buyer.call('POST', `/api/orders/${id}/flag`, { note: 'Cracked unit' });
  const o = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(o.disputed, 1);
  assert.equal(o.messages.length, 3);
  assert.equal(o.messages[0].body, '<script>alert(1)</script>', 'stored as text; the UI escapes it');
  await admin.call('POST', `/api/admin/orders/${id}/resolve`, { note: 'Replaced' });
  const r = await buyer.call('GET', `/api/orders/${id}`);
  assert.equal(r.disputed, 0);
  assert.match(r.messages.at(-1).body, /Kainat team: Replaced/);
});

test('order lists and details are private', async () => {
  const mine = await buyer.call('GET', '/api/orders');
  assert.ok(mine.every((o) => o.buyer_id === (mine[0].buyer_id)));
  const theirs = await other.call('GET', '/api/orders');
  assert.ok(!theirs.some((o) => mine.some((m) => m.id === o.id)));
  await rejects(other.call('GET', `/api/orders/${mine[0].id}`), 403);
  await rejects(buyer.call('GET', '/api/orders/99999'), 404);
  assert.ok((await admin.call('GET', '/api/orders')).length >= mine.length + theirs.length - 1);
});

test('contact details appear once the two sides have an order', async () => {
  const before = await other.call('GET', '/api/suppliers/4'); // Green Volt
  assert.equal(before.supplier.phone, '03003333333', 'Green Roof already traded with Green Volt');
  const fresh = await as(srv.base, '03019990000');
  await fresh.call('POST', '/api/onboard', { role: 'buyer', name: 'Fresh Buyer', city: 'Lahore' });
  assert.equal((await fresh.call('GET', '/api/suppliers/3')).supplier.phone, undefined);
  await fresh.call('POST', '/api/orders', { listing_id: sunCityListing.id, qty: 1, address: 'Gulberg' });
  assert.equal((await fresh.call('GET', '/api/suppliers/3')).supplier.phone, '03002222222');
});
