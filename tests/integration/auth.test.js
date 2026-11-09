// Sign-in, sessions, onboarding, profile and the role check on every API route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, rejects, as, PHONES } from '../helpers/server.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('health and anonymous /api/me', async () => {
  const c = new Client(srv.base);
  assert.equal((await c.call('GET', '/api/health')).ok, true);
  assert.equal((await c.me()).me, null);
});

test('auth/start rejects numbers that are not Pakistani mobiles', async () => {
  const c = new Client(srv.base);
  for (const phone of ['', '123', '0412345678', '04212345678', '030012345678', 'abc', null]) {
    await rejects(c.call('POST', '/api/auth/start', { phone }), 400, /mobile number/);
  }
  await rejects(c.call('POST', '/api/auth/start', {}), 400);
});

test('auth/start normalises the number and returns a 6-digit dev code', async () => {
  const c = new Client(srv.base);
  const r = await c.call('POST', '/api/auth/start', { phone: '+92 300 111 1111', channel: 'sms' });
  assert.equal(r.phone, PHONES.alNoor);
  assert.match(r.devCode, /^\d{6}$/);
  assert.equal(r.channel, 'sms');
  assert.equal((await c.call('POST', '/api/auth/start', { phone: PHONES.alNoor, channel: 'carrier-pigeon' })).channel, 'whatsapp');
});

test('a wrong code is rejected and a new code replaces the old one', async () => {
  const c = new Client(srv.base);
  const first = await c.call('POST', '/api/auth/start', { phone: PHONES.sunPeak });
  const second = await c.call('POST', '/api/auth/start', { phone: PHONES.sunPeak });
  await rejects(c.call('POST', '/api/auth/verify', { phone: PHONES.sunPeak, code: '000000' }), 400, /not right/);
  if (first.devCode !== second.devCode) {
    await rejects(c.call('POST', '/api/auth/verify', { phone: PHONES.sunPeak, code: first.devCode }), 400);
  }
  await c.call('POST', '/api/auth/verify', { phone: PHONES.sunPeak, code: second.devCode });
  assert.equal((await c.me()).me.name, 'SunPeak Energy');
});

test('a code works only once', async () => {
  const c = new Client(srv.base);
  const s = await c.call('POST', '/api/auth/start', { phone: PHONES.greenRoof });
  await c.call('POST', '/api/auth/verify', { phone: PHONES.greenRoof, code: s.devCode });
  await rejects(new Client(srv.base).call('POST', '/api/auth/verify', { phone: PHONES.greenRoof, code: s.devCode }), 400);
});

test('verify with no code, or for a number that never asked, is rejected', async () => {
  const c = new Client(srv.base);
  await rejects(c.call('POST', '/api/auth/verify', { phone: '03459999999', code: '123456' }), 400);
  await c.call('POST', '/api/auth/start', { phone: '03459999998' });
  await rejects(c.call('POST', '/api/auth/verify', { phone: '03459999998' }), 400);
});

test('an expired code is rejected', async () => {
  const c = new Client(srv.base);
  const s = await c.call('POST', '/api/auth/start', { phone: PHONES.bright });
  const db = srv.db();
  db.prepare('UPDATE otps SET at = ? WHERE phone = ?').run(new Date(Date.now() - 11 * 60000).toISOString(), PHONES.bright);
  db.close();
  await rejects(c.call('POST', '/api/auth/verify', { phone: PHONES.bright, code: s.devCode }), 400, /expired/);
});

test('logout ends the session', async () => {
  const c = await as(srv.base, 'alNoor');
  const cookie = c.cookie;
  await c.call('POST', '/api/auth/logout');
  const stale = new Client(srv.base);
  stale.cookie = cookie;
  assert.equal((await stale.me()).me, null);
  await rejects(stale.call('GET', '/api/shop'), 401);
});

test('a forged or malformed session cookie is treated as signed out', async () => {
  const c = new Client(srv.base);
  for (const cookie of ['sid=' + 'a'.repeat(48), 'sid=nothex', 'sid=', 'other=1']) {
    c.cookie = cookie;
    assert.equal((await c.me()).me, null, cookie);
  }
});

test('a new number must finish onboarding before using the app', async () => {
  const c = new Client(srv.base);
  const me = await c.login('03451111111');
  assert.equal(me.role, null);
  await rejects(c.call('GET', '/api/catalog'), 403, /Finish setting up/);
  await rejects(c.call('POST', '/api/onboard', { role: 'admin', name: 'X', city: 'Lahore' }), 400, /buyer or supplier/);
  await rejects(c.call('POST', '/api/onboard', { role: 'buyer', name: '  ', city: 'Lahore' }), 400, /business name/);
  await rejects(c.call('POST', '/api/onboard', { role: 'buyer', name: 'Zed Solar' }), 400, /city/);
  await c.call('POST', '/api/onboard', { role: 'buyer', name: 'Zed Solar', city: 'Multan', installs: '5 to 20', buys: 'Panels' });
  const after1 = (await c.me()).me;
  assert.equal(after1.role, 'buyer');
  assert.equal(after1.city, 'Multan');
  await rejects(c.call('POST', '/api/onboard', { role: 'supplier', name: 'Again', city: 'Lahore' }), 409);
});

test('supplier sign-up: type defaults safely, NTN marks documents received, welcome WhatsApp sent', async () => {
  const c = new Client(srv.base);
  await c.login('03452222222');
  await c.call('POST', '/api/onboard', { role: 'supplier', name: 'Sun Traders', city: 'Lahore', supplier_type: 'hacker', ntn: '999' });
  const me = (await c.me()).me;
  assert.equal(me.supplier_type, 'wholesaler');
  assert.equal(me.docs_status, 'received');
  assert.equal(me.delivery_cities, 'Lahore');
  assert.equal(me.claimed, true);
  const wa = await c.call('GET', '/api/whatsapp');
  assert.match(wa[0].body, /Welcome to the marketplace|Welcome/);
});

test('profile update keeps required fields, ignores bad types and marks NTN received', async () => {
  const c = new Client(srv.base);
  await c.login('03453333333');
  await c.call('POST', '/api/onboard', { role: 'supplier', name: 'Profile Co', city: 'Lahore' });
  await c.call('PUT', '/api/me', { name: '', city: '', supplier_type: 'bogus', ntn: '1234567-1', years: 'abc', contact: 'Ali' });
  const me = (await c.me()).me;
  assert.equal(me.name, 'Profile Co');
  assert.equal(me.city, 'Lahore');
  assert.equal(me.supplier_type, 'wholesaler');
  assert.equal(me.docs_status, 'received');
  assert.equal(me.years, null);
  assert.equal(me.contact, 'Ali');
});

test('a very long name is cut to a safe length', async () => {
  const c = new Client(srv.base);
  await c.login('03454444444');
  await c.call('POST', '/api/onboard', { role: 'buyer', name: 'N'.repeat(500), city: 'Lahore' });
  assert.equal((await c.me()).me.name.length, 120);
});

test('a team-built shop signs in unclaimed, claims once, and gets matching requests', async () => {
  const c = await as(srv.base, 'newEra');
  assert.equal((await c.me()).me.claimed, false);
  await c.call('POST', '/api/claim');
  await c.call('POST', '/api/claim');
  assert.equal((await c.me()).me.claimed, true);
  const reqs = await c.call('GET', '/api/requests');
  assert.ok(reqs.length >= 1);
});

test('me counts reflect the account', async () => {
  const s = await as(srv.base, 'alNoor');
  const { counts } = await s.me();
  for (const k of ['open_requests', 'pending_orders', 'listings', 'unconfirmed_today', 'whatsapp', 'unread_chats']) assert.equal(typeof counts[k], 'number', k);
  const b = await as(srv.base, 'sunPeak');
  assert.equal(typeof (await b.me()).counts.new_quotes, 'number');
});

// Every route with the roles that may call it. Anything else must be refused.
const ROUTES = [
  ['POST', '/api/onboard', 'any'], ['POST', '/api/claim', 'supplier'], ['PUT', '/api/me', 'user'], ['GET', '/api/catalog', 'user'],
  ['POST', '/api/models', 'user'], ['GET', '/api/search', 'user'], ['GET', '/api/models/1/offers', 'user'], ['GET', '/api/listings/1', 'user'],
  ['GET', '/api/quotes/1', 'buyer'], ['GET', '/api/suppliers/2', 'user'], ['POST', '/api/requests', 'buyer'], ['GET', '/api/requests', 'user'],
  ['GET', '/api/requests/1', 'user'], ['POST', '/api/requests/1/cancel', 'buyer'], ['POST', '/api/requests/1/quote', 'supplier'],
  ['POST', '/api/requests/1/pass', 'supplier'], ['POST', '/api/requests/1/instant-bid', 'supplier'], ['GET', '/api/requests/1/board', 'user'],
  ['POST', '/api/chats', 'user'], ['GET', '/api/chats', 'user'], ['GET', '/api/chats/1', 'user'], ['POST', '/api/chats/1/messages', 'user'],
  ['GET', '/api/chats/1/files/1', 'user'], ['POST', '/api/invite-supplier', 'buyer'], ['GET', '/api/addresses', 'buyer'], ['POST', '/api/orders', 'buyer'],
  ['GET', '/api/orders', 'user'], ['GET', '/api/orders/1', 'user'], ['GET', '/api/orders/1/proof', 'user'], ['POST', '/api/orders/1/proof', 'buyer'],
  ['POST', '/api/orders/1/accept', 'supplier'], ['POST', '/api/orders/1/decline', 'supplier'], ['POST', '/api/orders/1/dispatch', 'supplier'],
  ['POST', '/api/orders/1/deliver', 'buyer'], ['POST', '/api/orders/1/cancel', 'buyer'], ['POST', '/api/orders/1/flag', 'user'],
  ['POST', '/api/orders/1/messages', 'user'], ['GET', '/api/shop', 'supplier'], ['POST', '/api/listings', 'supplier'], ['PUT', '/api/listings/1', 'supplier'],
  ['POST', '/api/listings/confirm-all', 'supplier'], ['GET', '/api/listings/1/history', 'supplier'], ['GET', '/api/whatsapp', 'user'], ['POST', '/api/whatsapp', 'user'],
  ['GET', '/api/admin/overview', 'admin'], ['GET', '/api/admin/businesses', 'admin'], ['PUT', '/api/admin/businesses/2', 'admin'],
  ['POST', '/api/admin/suppliers', 'admin'], ['POST', '/api/admin/suppliers/2/items', 'admin'], ['GET', '/api/admin/models', 'admin'],
  ['POST', '/api/admin/models/1/approve', 'admin'], ['POST', '/api/admin/orders/1/resolve', 'admin'], ['POST', '/api/admin/price-check', 'admin'],
  ['GET', '/api/admin/whatsapp', 'admin'], ['GET', '/api/admin/requests', 'admin'],
];

test('every protected route refuses anonymous callers with 401', async () => {
  const anon = new Client(srv.base);
  for (const [m, p] of ROUTES) {
    const res = await anon.raw(m, p, m === 'GET' ? undefined : {});
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

test('role-restricted routes refuse the wrong role with 403', async () => {
  const buyer = await as(srv.base, 'brightWorks');
  const supplier = await as(srv.base, 'abbas');
  const admin = await as(srv.base, 'admin');
  for (const [m, p, role] of ROUTES) {
    const body = m === 'GET' ? undefined : {};
    if (role === 'supplier' || role === 'admin') assert.equal((await buyer.raw(m, p, body)).status, 403, `buyer ${m} ${p}`);
    if (role === 'buyer' || role === 'admin') assert.equal((await supplier.raw(m, p, body)).status, 403, `supplier ${m} ${p}`);
    if (role === 'buyer' || role === 'supplier') assert.equal((await admin.raw(m, p, body)).status, 403, `admin ${m} ${p}`);
  }
});

test('unknown API paths return 404 JSON', async () => {
  const res = await new Client(srv.base).raw('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Not found');
  assert.equal((await new Client(srv.base).raw('DELETE', '/api/me')).status, 404);
});

test('malformed and oversized request bodies are rejected cleanly', async () => {
  const c = new Client(srv.base);
  const bad = await c.raw('POST', '/api/auth/start', '{not json', { 'Content-Type': 'application/json' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Invalid JSON/);
  const huge = await c.raw('POST', '/api/auth/start', JSON.stringify({ phone: 'x'.repeat(11 * 1024 * 1024) }));
  assert.equal(huge.status, 413);
  assert.match((await huge.json()).error, /too large/);
  assert.equal((await c.call('GET', '/api/health')).ok, true, 'server still up after a huge body');
});

test('a suspended account is signed out and blocked, and can be reactivated', async () => {
  const admin = await as(srv.base, 'admin');
  const g = await as(srv.base, 'greenVolt');
  await admin.call('PUT', '/api/admin/businesses/4', { status: 'suspended' });
  await rejects(g.call('GET', '/api/shop'), 401);
  const again = new Client(srv.base);
  await again.login(PHONES.greenVolt);
  await rejects(again.call('GET', '/api/shop'), 403, /suspended/);
  await admin.call('PUT', '/api/admin/businesses/4', { status: 'active' });
  assert.ok(Array.isArray(await again.call('GET', '/api/shop')));
});
