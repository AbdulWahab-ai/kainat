// Chat rules and attachments, the admin console, and static file serving.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, rejects, as, PNG, PDF } from '../helpers/server.js';

let srv, buyer, other, alNoor, sunCity, abbas, admin, M;
before(async () => {
  srv = await startServer();
  [buyer, other, alNoor, sunCity, abbas, admin] = await Promise.all(['sunPeak', 'brightWorks', 'alNoor', 'sunCity', 'abbas', 'admin'].map((w) => as(srv.base, w)));
  M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
});
after(async () => { await srv.stop(); });

// ---------- chat ----------
test('who can start a chat with whom', async () => {
  await rejects(buyer.call('POST', '/api/chats', { with_id: 99999 }), 404);
  await rejects(buyer.call('POST', '/api/chats', { with_id: 9 }), 400, /between a buyer and a supplier/); // another buyer
  await rejects(alNoor.call('POST', '/api/chats', { with_id: 3 }), 400); // supplier to supplier
  await rejects(abbas.call('POST', '/api/chats', { with_id: 10 }), 403, /sent you a request or ordered/); // cold pitch
  const a = await buyer.call('POST', '/api/chats', { with_id: 6 });
  const b = await buyer.call('POST', '/api/chats', { with_id: '6' });
  assert.equal(a.id, b.id, 'reopening returns the same chat');
  const s = await alNoor.call('POST', '/api/chats', { with_id: 8 }); // traded with SunPeak
  assert.ok(s.id);
});

test('chats about a request: buyer may open with any supplier (who then gets the request), supplier only if targeted', async () => {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Pylontech US3000C'], qty: 1, city: 'Lahore' });
  await rejects(abbas.call('POST', '/api/chats', { with_id: 8, request_id: r.id }), 403, /not sent to you/);
  await rejects(other.call('POST', '/api/chats', { with_id: 6, request_id: r.id }), 404);
  const c = await buyer.call('POST', '/api/chats', { with_id: 6, request_id: r.id });
  assert.ok(c.id);
  assert.ok((await abbas.call('GET', '/api/requests')).some((x) => x.id === r.id), 'Abbas now has the request');
  const s = await sunCity.call('POST', '/api/chats', { with_id: 8, request_id: r.id });
  assert.ok(s.id);
});

test('a chat with no messages is hidden from the list', async () => {
  const c = await buyer.call('POST', '/api/chats', { with_id: 5 });
  assert.ok(!(await buyer.call('GET', '/api/chats')).some((x) => x.id === c.id));
});

test('messages: validation, attachments, polling, unread counts and one WhatsApp nudge per batch', async () => {
  const { id } = await buyer.call('POST', '/api/chats', { with_id: 2 });
  await rejects(buyer.call('POST', `/api/chats/${id}/messages`, {}), 400);
  await rejects(buyer.call('POST', `/api/chats/${id}/messages`, { body: '  ' }), 400);
  await rejects(buyer.call('POST', `/api/chats/${id}/messages`, { attachment: 'data:text/plain;base64,aGk=' }), 400, /image|PDF/);
  const before = (await alNoor.call('GET', '/api/whatsapp')).length;
  const m1 = await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'Datasheet attached', attachment: PDF, attachment_name: 'spec.pdf' });
  await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'And a photo', attachment: PNG, attachment_name: 'roof.png' });
  await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'Third message' });
  // One nudge per batch of unread messages. It reaches WhatsApp at once, or in the next 15-minute batch if
  // Al-Noor had another alert just before.
  const nudges = (await alNoor.call('GET', '/api/notifications')).items.filter((n) => n.event === 'chat_message' && n.link === `#/chat/${id}`);
  assert.equal(nudges.length, 1, 'only the first unread message nudges');
  assert.ok((await alNoor.call('GET', '/api/whatsapp')).slice(before).filter((m) => m.buttons?.includes('Open chat')).length <= 1);
  assert.equal((await alNoor.me()).counts.unread_chats >= 1, true);
  const list = (await alNoor.call('GET', '/api/chats')).find((c) => c.id === id);
  assert.equal(list.unread, 3);
  assert.equal(list.last.body, 'Third message');
  const t = await alNoor.call('GET', `/api/chats/${id}`);
  assert.equal(t.messages.filter((m) => m.has_file).length, 2);
  assert.equal((await alNoor.call('GET', '/api/chats')).find((c) => c.id === id).unread, 0, 'opening marks read');
  const newer = await alNoor.call('GET', `/api/chats/${id}?after=${m1.id}`);
  assert.equal(newer.messages.length, 2);
  const pdf = await fetch(`${srv.base}/api/chats/${id}/files/${m1.id}`, { headers: { cookie: alNoor.cookie } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const none = await fetch(`${srv.base}/api/chats/${id}/files/${t.messages.at(-1).id}`, { headers: { cookie: alNoor.cookie } });
  assert.equal(none.status, 404);
  // The other party replies; the buyer's next nudge resets after reading.
  await alNoor.call('POST', `/api/chats/${id}/messages`, { body: 'Received' });
  assert.equal((await buyer.call('GET', '/api/chats')).find((c) => c.id === id).unread, 1);
});

test('chats are private: outsiders cannot read, write or download; admins can read but not write', async () => {
  const { id } = await buyer.call('POST', '/api/chats', { with_id: 3 });
  const m = await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'Private', attachment: PNG, attachment_name: 'p.png' });
  await rejects(other.call('GET', `/api/chats/${id}`), 403);
  await rejects(alNoor.call('POST', `/api/chats/${id}/messages`, { body: 'hi' }), 403);
  assert.equal((await fetch(`${srv.base}/api/chats/${id}/files/${m.id}`, { headers: { cookie: other.cookie } })).status, 403);
  assert.equal((await admin.call('GET', `/api/chats/${id}`)).messages.length, 1);
  await rejects(admin.call('POST', `/api/chats/${id}/messages`, { body: 'hi' }), 403);
  await rejects(buyer.call('GET', '/api/chats/99999'), 404);
});

test('bids appear in the request chat with the current bid and board', async () => {
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 2, city: 'Lahore' });
  await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 320000, qty: 5 });
  await alNoor.call('POST', `/api/requests/${r.id}/quote`, { price: 318000, qty: 5 });
  const c = (await buyer.call('GET', '/api/chats')).find((x) => x.request_id === r.id);
  const t = await buyer.call('GET', `/api/chats/${c.id}`);
  assert.deepEqual(t.messages.map((m) => m.kind), ['bid', 'bid']);
  assert.match(t.messages[1].body, /^Revised bid/);
  assert.equal(t.conversation.quote.price, 318000);
  assert.equal(t.conversation.board.count, 1);
});

// ---------- admin ----------
test('admin overview returns metrics and counts', async () => {
  const o = await admin.call('GET', '/api/admin/overview');
  assert.equal(o.metrics.length, 7);
  for (const k of ['suppliers', 'unclaimed', 'buyers', 'pending_models', 'disputes', 'docs_to_check', 'open_requests']) assert.equal(typeof o.counts[k], 'number', k);
});

test('business list filters by role and excludes the admin', async () => {
  const all = await admin.call('GET', '/api/admin/businesses');
  assert.ok(!all.some((b) => b.role === 'admin'));
  assert.ok((await admin.call('GET', '/api/admin/businesses?role=buyer')).every((b) => b.role === 'buyer'));
});

test('updating a business ignores invalid values and 404s on unknown ids', async () => {
  await admin.call('PUT', '/api/admin/businesses/6', { docs_status: 'hacked', status: 'deleted', verified: true });
  const b = (await admin.call('GET', '/api/admin/businesses')).find((x) => x.id === 6);
  assert.deepEqual([b.docs_status, b.status, b.verified], ['received', 'active', 1]);
  await rejects(admin.call('PUT', '/api/admin/businesses/99999', {}), 404);
});

test('building a supplier shop: validation, items, targeting and WhatsApp welcome', async () => {
  await rejects(admin.call('POST', '/api/admin/suppliers', { name: 'X', city: 'Lahore', phone: '12' }), 400, /mobile number/);
  await rejects(admin.call('POST', '/api/admin/suppliers', { name: 'X', city: 'Lahore', phone: '03001111111' }), 409, /already has an account/);
  await rejects(admin.call('POST', '/api/admin/suppliers', { city: 'Lahore', phone: '03018880000' }), 400, /business name/);
  await rejects(admin.call('POST', '/api/admin/suppliers', { name: 'X', phone: '03018880000' }), 400, /city/);
  const r = await buyer.call('POST', '/api/requests', { model_id: M['Dyness B4850'], qty: 4, city: 'Lahore' });
  const built = await admin.call('POST', '/api/admin/suppliers', { name: 'Battery Hub', phone: '0301 888 0000', city: 'Lahore', contact: 'Kamran',
    items: [{ model_id: M['Dyness B4850'], price: 95000, qty: 10 }, { model_id: M['Dyness B4850'], price: 1 }, { model_id: '', price: 5 }, { model_id: M['Pylontech US5000'] }] });
  assert.equal(built.items, 2, 'two rows had a model and a price');
  assert.ok(built.requests_waiting >= 1);
  const s = await as(srv.base, '03018880000');
  const shop = await s.call('GET', '/api/shop');
  assert.equal(shop.length, 1, 'the duplicate model row is skipped');
  assert.equal(shop[0].source, 'team');
  assert.ok((await s.call('GET', '/api/requests')).some((x) => x.id === r.id));
  assert.match((await s.call('GET', '/api/whatsapp'))[0].body, /Kamran sahib.*Battery Hub/s);
  await rejects(admin.call('POST', `/api/admin/suppliers/${(await s.me()).me.id}/items`, { model_id: M['Dyness B4850'], price: 1 }), 409);
  assert.ok((await admin.call('POST', `/api/admin/suppliers/${(await s.me()).me.id}/items`, { model_id: M['Narada 51.2V 100Ah'], price: 250000 })).id);
  await rejects(admin.call('POST', '/api/admin/suppliers/8/items', { model_id: M['Narada 51.2V 100Ah'], price: 1 }), 404, /Supplier not found/);
  await rejects(admin.call('POST', '/api/admin/suppliers/2/items', { price: 1 }), 400, /model/);
});

test('catalogue moderation: approve, reject, merge and unknown actions', async () => {
  const p1 = await abbas.call('POST', '/api/models', { category: 'battery', brand: 'Pylon', name: 'US-5000' });
  const p2 = await abbas.call('POST', '/api/models', { category: 'battery', brand: 'NewBrand', name: 'NB1' });
  await abbas.call('POST', '/api/listings', { model_id: p1.id, price: 300000, qty: 2 });
  await rejects(admin.call('POST', `/api/admin/models/${p1.id}/explode`), 400);
  await rejects(admin.call('POST', '/api/admin/models/99999/approve'), 404);
  await rejects(admin.call('POST', `/api/admin/models/${p1.id}/merge`, {}), 400, /merge into/);
  await admin.call('POST', `/api/admin/models/${p1.id}/merge`, { into: M['Pylontech US5000'] });
  const shop = await abbas.call('GET', '/api/shop');
  assert.ok(shop.some((l) => l.model_id === M['Pylontech US5000']), 'listing moved to the real model');
  const models = await admin.call('GET', '/api/admin/models');
  assert.equal(models.find((m) => m.id === p1.id).status, 'rejected');
  await admin.call('POST', `/api/admin/models/${p2.id}/approve`);
  assert.ok((await buyer.call('GET', '/api/catalog?q=NewBrand')).some((m) => m.id === p2.id));
  await admin.call('POST', `/api/admin/models/${p2.id}/reject`);
  assert.ok(!(await buyer.call('GET', '/api/catalog?q=NewBrand')).some((m) => m.id === p2.id));
});

test('merging into a model the supplier already lists hides the duplicate instead of colliding', async () => {
  const dup = await alNoor.call('POST', '/api/models', { category: 'panel', brand: 'LONGi', name: 'HiMO6 580' });
  await alNoor.call('POST', '/api/listings', { model_id: dup.id, price: 17000, qty: 5 });
  await admin.call('POST', `/api/admin/models/${dup.id}/merge`, { into: M['Longi Hi-MO 6 580 W'] });
  const shop = await alNoor.call('GET', '/api/shop');
  assert.equal(shop.filter((l) => l.model_id === M['Longi Hi-MO 6 580 W']).length, 1);
  assert.equal(shop.find((l) => l.model_id === dup.id)?.visible, 0);
});

test('resolving disputes, price check, WhatsApp log and request list', async () => {
  await rejects(admin.call('POST', '/api/admin/orders/99999/resolve', {}), 404);
  const pc = await admin.call('POST', '/api/admin/price-check');
  assert.ok(pc.sent >= 6);
  const log = await admin.call('GET', '/api/admin/whatsapp');
  assert.ok(log.length > 0 && log.length <= 150 && log[0].name);
  const reqs = await admin.call('GET', '/api/admin/requests');
  assert.ok(reqs.every((r) => typeof r.sent_to === 'number' && typeof r.quotes === 'number'));
});

// ---------- static files ----------
test('static files are served with the right types and unknown paths fall back to the app', async () => {
  const c = new Client(srv.base);
  for (const [p, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'text/javascript'], ['/js/core.js', 'text/javascript'], ['/icon.svg', 'image/svg+xml']]) {
    const res = await c.raw('GET', p);
    assert.equal(res.status, 200, p);
    assert.ok(res.headers.get('content-type').startsWith(type), p);
  }
  assert.match(await (await c.raw('GET', '/some/deep/link')).text(), /<title>Kainat<\/title>/);
  assert.equal((await c.raw('GET', '/missing.css')).status, 404);
  assert.equal((await c.raw('HEAD', '/')).status, 200);
  assert.equal((await c.raw('POST', '/styles.css', {})).status, 405);
});

test('path traversal outside the public folder is blocked', async () => {
  for (const p of ['/../server.js', '/..%2Fserver.js', '/%2e%2e/src/api.js', '/js/../../package.json', '/..%5Cserver.js']) {
    const res = await fetch(srv.base + p);
    const text = await res.text();
    assert.ok(!/handleApi|"devDependencies"|import http/.test(text), `${p} leaked source (status ${res.status})`);
  }
});

test('the database and uploads are never served as static files', async () => {
  for (const p of ['/data/app.db', '/app.db', '/uploads/x.png', '/.env']) {
    const res = await fetch(srv.base + p);
    assert.ok(res.status === 404 || /<title>Kainat/.test(await res.text()), p);
  }
});
