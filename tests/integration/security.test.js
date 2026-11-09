// Security hardening: sign-in codes (never shown in production, wrong-code and request limits), sessions (expiry,
// secure cookies, sign out everywhere), uploads checked by content, and phone numbers kept off the platform.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, rejects, as, Client, PNG, PDF } from '../helpers/server.js';

const start = (c, phone, extra = {}) => c.call('POST', '/api/auth/start', { phone, ...extra });
const verify = (c, phone, code) => c.call('POST', '/api/auth/verify', { phone, code });
const sql = (srv, q, ...p) => { const db = srv.db(); try { return db.prepare(q).all(...p); } finally { db.close(); } };

describe('sign-in codes in production', () => {
  let srv, gateway, sent = [];
  before(async () => {
    // A stand-in SMS gateway that records what Kainat asks it to send.
    gateway = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => { sent.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{}'); });
    });
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    srv = await startServer({ NODE_ENV: 'production', SMS_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}/send`, SMS_GATEWAY_TOKEN: 'test-token' });
  });
  after(async () => { await srv.stop(); gateway.close(); });

  test('the code goes to the gateway and is never returned to the browser; no demo accounts', async () => {
    const c = new Client(srv.base);
    assert.deepEqual(await c.call('GET', '/api/config'), { demo: false });
    const r = await start(c, '0300 1111111', { channel: 'sms' });
    assert.equal(r.devCode, undefined);
    assert.deepEqual(Object.keys(r).sort(), ['channel', 'phone']);
    const last = sent.at(-1);
    assert.equal(last.auth, 'Bearer test-token');
    assert.equal(last.body.to, '+923001111111');
    assert.equal(last.body.channel, 'sms');
    const code = /(\d{6})/.exec(last.body.text)[1];
    await verify(c, '03001111111', code);
    assert.equal((await c.me()).me.name, 'Al-Noor Solar Imports');
  });

  test('cookies are marked Secure behind an HTTPS proxy only when the proxy is trusted', async () => {
    const c = new Client(srv.base);
    await start(c, '03002222222');
    const code = /(\d{6})/.exec(sent.at(-1).body.text)[1];
    const res = await c.raw('POST', '/api/auth/verify', { phone: '03002222222', code }, { 'x-forwarded-proto': 'https' });
    assert.doesNotMatch(res.headers.get('set-cookie'), /Secure/, 'TRUST_PROXY is not set, so the header is ignored');
  });
});

describe('sign-in without a gateway in production', () => {
  let srv;
  before(async () => { srv = await startServer({ NODE_ENV: 'production', TRUST_PROXY: '1' }); });
  after(async () => { await srv.stop(); });

  test('refuses to start rather than pretending a code was sent', async () => {
    await rejects(start(new Client(srv.base), '03001111111'), 503, /cannot be sent yet/);
  });
});

describe('secure cookies behind a trusted proxy', () => {
  let srv;
  before(async () => { srv = await startServer({ TRUST_PROXY: '1' }); });
  after(async () => { await srv.stop(); });

  test('Secure is added when the trusted proxy says the visitor used HTTPS', async () => {
    const c = new Client(srv.base);
    const { devCode } = await start(c, '03001111111');
    const res = await c.raw('POST', '/api/auth/verify', { phone: '03001111111', code: devCode }, { 'x-forwarded-proto': 'https' });
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=2592000/);
  });
});

describe('sign-in limits', () => {
  let srv;
  before(async () => { srv = await startServer({ OTP_MAX_PER_HOUR: '3', OTP_MIN_GAP_SEC: '30', OTP_MAX_PER_IP_HOUR: '8' }); });
  after(async () => { await srv.stop(); });

  test('development returns the code, and wrong codes are limited to 5', async () => {
    const c = new Client(srv.base);
    assert.deepEqual(await c.call('GET', '/api/config'), { demo: true });
    const { devCode } = await start(c, '03001111111');
    assert.match(devCode, /^\d{6}$/);
    const wrong = devCode === '111111' ? '222222' : '111111';
    await rejects(verify(c, '03001111111', wrong), 400, /4 tries left/);
    for (const left of ['3 tries', '2 tries', '1 try']) await rejects(verify(c, '03001111111', wrong), 400, new RegExp(left));
    await rejects(verify(c, '03001111111', wrong), 400, /Too many wrong codes/);
    await rejects(verify(c, '03001111111', devCode), 400, /Ask for a new one/, 'the code is gone after too many tries');
  });

  test('a right code after a few wrong ones still works', async () => {
    const c = new Client(srv.base);
    await srv.advance(1);
    const { devCode } = await start(c, '03002222222');
    await rejects(verify(c, '03002222222', '000000'), 400);
    await verify(c, '03002222222', devCode);
    assert.equal((await c.me()).me.name, 'Sun City Traders');
  });

  test('codes for one number: 30 seconds apart and at most 3 an hour', async () => {
    const c = new Client(srv.base);
    await start(c, '03003333333');
    await rejects(start(c, '03003333333'), 429, /Wait \d+ seconds/);
    await srv.advance(1); await start(c, '03003333333');
    await srv.advance(1); await start(c, '03003333333');
    await srv.advance(1); await rejects(start(c, '03003333333'), 429, /Too many codes for this number\. Try again in \d+ minutes/);
    await srv.advance(60); await start(c, '03003333333');
  });

  test('codes from one network address are capped per hour', async () => {
    await srv.advance(61);
    const c = new Client(srv.base);
    for (let i = 0; i < 8; i++) await start(c, `0310000000${i}`);
    await rejects(start(c, '03100000009'), 429, /from this network/);
  });

  test('a bad number is refused before any limit is used up', async () => {
    await rejects(start(new Client(srv.base), '12345'), 400, /Pakistani mobile/);
  });
});

describe('sessions', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  test('a session ends after 30 days without use, but keeps going while it is used', async () => {
    const active = await as(srv.base, 'sunPeak');
    const idle = await as(srv.base, 'greenRoof');
    for (let i = 0; i < 3; i++) { await srv.advance(20 * 24 * 60); await active.me(); }
    assert.equal((await active.me()).me.name, 'SunPeak Energy', '60 days, used every 20 days');
    await rejects(idle.call('GET', '/api/orders'), 401);
  });

  test('every session ends 90 days after sign-in, however often it is used', async () => {
    const c = await as(srv.base, 'alNoor');
    for (let i = 0; i < 4; i++) { await srv.advance(20 * 24 * 60); await c.me(); }
    await srv.advance(11 * 24 * 60);
    await rejects(c.call('GET', '/api/orders'), 401);
  });

  test('sign out on all devices ends every session for the number', async () => {
    const phone = await as(srv.base, 'sunCity');
    const laptop = await as(srv.base, 'sunCity');
    const r = await phone.call('POST', '/api/auth/logout-all');
    assert.ok(r.ended >= 2);
    await rejects(laptop.call('GET', '/api/orders'), 401);
    await rejects(phone.call('GET', '/api/orders'), 401);
    await rejects(new Client(srv.base).call('POST', '/api/auth/logout-all'), 401);
  });

  test('the cleanup job removes old code requests and ended sessions', async () => {
    await as(srv.base, 'bright');
    await srv.advance(31 * 24 * 60);
    const r = await srv.tick(['cleanup']);
    assert.ok(r.cleanup >= 1);
    assert.equal(sql(srv, "SELECT COUNT(*) n FROM otp_requests WHERE at < datetime('now', '-1 day')")[0].n, 0);
  });
});

describe('uploads are checked by what they really are', () => {
  let srv, buyer, sunCity;
  before(async () => { srv = await startServer(); [buyer, sunCity] = await Promise.all(['sunPeak', 'sunCity'].map((w) => as(srv.base, w))); });
  after(async () => { await srv.stop(); });

  test('a script renamed as an image, or a file with the wrong type, is refused', async () => {
    const { id } = await buyer.call('POST', '/api/chats', { with_id: 3 });
    const fake = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    await rejects(buyer.call('POST', `/api/chats/${id}/messages`, { body: 'x', attachment: fake }), 400, /not a real image or PDF/);
    const pngAsPdf = 'data:application/pdf;base64,' + PNG.split(',')[1];
    await rejects(buyer.call('POST', `/api/chats/${id}/messages`, { body: 'x', attachment: pngAsPdf }), 400, /PNG file named as PDF/);
    await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'real files', attachment: PNG, attachment_name: 'site.png' });
    await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'real pdf', attachment: PDF, attachment_name: 'spec.pdf' });
    const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
    await rejects(buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Gulberg', token_proof: fake }), 400, /Token proof is not a real image/);
  });
});

describe('phone numbers stay on Kainat', () => {
  let srv, buyer, sunCity, alNoor, admin, M;
  before(async () => {
    srv = await startServer();
    [buyer, sunCity, alNoor, admin] = await Promise.all(['sunPeak', 'sunCity', 'alNoor', 'admin'].map((w) => as(srv.base, w)));
    M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
  });
  after(async () => { await srv.stop(); });

  test('a chat message with a number is refused with what the screen needs for its warning', async () => {
    const { id } = await buyer.call('POST', '/api/chats', { with_id: 3 });
    const e = await rejects(buyer.call('POST', `/api/chats/${id}/messages`, { body: 'Mera number 0300 1234567 hai' }), 422, /can’t be shared/);
    assert.equal(e.body.code, 'phone_number');
    assert.equal(e.body.role, 'buyer');
    assert.equal(e.body.attempts, 1);
    const e2 = await rejects(sunCity.call('POST', `/api/chats/${id}/messages`, { body: 'call 0321-7654321' }), 422);
    assert.equal(e2.body.role, 'supplier');
    const thread = await sunCity.call('GET', `/api/chats/${id}`);
    assert.ok(!thread.messages.some((m) => /1234567|7654321/.test(m.body)), 'nothing was saved');
  });

  test('"send without the number" saves it masked and tells both sides', async () => {
    const { id } = await buyer.call('POST', '/api/chats', { with_id: 3 });
    const r = await buyer.call('POST', `/api/chats/${id}/messages`, { body: 'WhatsApp me at +92 300 1234567 for the bill', mask: true });
    assert.equal(r.masked, true);
    const msgs = (await sunCity.call('GET', `/api/chats/${id}`)).messages;
    const mine = msgs.find((m) => m.id === r.id);
    assert.equal(mine.body, 'WhatsApp me at [number hidden] for the bill');
    assert.match(msgs.at(-1).body, /phone number was removed/);
    assert.equal(msgs.at(-1).kind, 'system');
    // The WhatsApp nudge to the other side carries the masked text too.
    assert.ok(!sql(srv, 'SELECT body FROM notifications').some((n) => /1234567/.test(n.body)));
  });

  test('order messages, request descriptions, order addresses and notes, and quote notes are all guarded', async () => {
    const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
    await rejects(buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'House 9, call 0300 1112223' }), 422);
    await rejects(buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Gulberg', note: 'site manager 03211234567' }), 422);
    const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Gulberg', note: 'site manager 03211234567', mask: true });
    const ov = await sunCity.call('GET', `/api/orders/${o.id}`);
    assert.equal(ov.note, 'site manager [number hidden]');
    await rejects(sunCity.call('POST', `/api/orders/${o.id}/messages`, { body: 'call me 0300-2222222' }), 422);
    await sunCity.call('POST', `/api/orders/${o.id}/messages`, { body: 'call me 0300-2222222', mask: true });
    const msgs = (await buyer.call('GET', `/api/orders/${o.id}`)).messages;
    assert.equal(msgs.at(-2).body, 'call me [number hidden]');
    assert.match(msgs.at(-1).body, /phone number was removed/);
    await rejects(buyer.call('POST', '/api/requests', { category: 'battery', description: '5 kWh, call 03001234567', qty: 1, city: 'Lahore' }), 422);
    const req = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
    await rejects(alNoor.call('POST', `/api/requests/${req.id}/quote`, { price: 320000, qty: 1, note: 'ring 0300 9998887' }), 422);
    await alNoor.call('POST', `/api/requests/${req.id}/quote`, { price: 320000, qty: 1, note: 'ring 0300 9998887', mask: true });
    assert.equal((await buyer.call('GET', `/api/requests/${req.id}`)).quotes.find((q) => q.supplier.id === 2).note, 'ring [number hidden]');
  });

  test('business details, ratings and replies refuse numbers outright', async () => {
    await rejects(buyer.call('PUT', '/api/me', { name: 'SunPeak Energy', address: 'Johar Town, 0300 1234567' }), 400, /business details/);
    await rejects(buyer.call('PUT', '/api/me', { name: 'SunPeak 03001234567' }), 400);
    await buyer.call('PUT', '/api/me', { name: 'SunPeak Energy', city: 'Lahore', address: 'Johar Town, Block K' });
    const fresh = await as(srv.base, '03019990001');
    await rejects(fresh.call('POST', '/api/onboard', { role: 'buyer', name: 'Ali 03001234567', city: 'Lahore' }), 400);
    const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
    const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Gulberg' });
    await sunCity.call('POST', `/api/orders/${o.id}/accept`);
    await buyer.call('POST', `/api/orders/${o.id}/deliver`);
    await rejects(buyer.call('POST', `/api/orders/${o.id}/rating`, { stars: 5, comment: 'Great, call them on 0300 2222222' }), 400, /ratings/);
  });

  test('a decline reason and a flagged problem hide numbers from the other side', async () => {
    const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
    const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Gulberg' });
    await sunCity.call('POST', `/api/orders/${o.id}/decline`, { reason: 'Out of stock, call 0300 2222222' });
    assert.equal((await buyer.call('GET', `/api/orders/${o.id}`)).decline_reason, 'Out of stock, call [number hidden]');
    const o2 = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Gulberg' });
    await buyer.call('POST', `/api/orders/${o2.id}/flag`, { note: 'Wrong item, my number is 03211111111' });
    assert.doesNotMatch((await sunCity.call('GET', `/api/orders/${o2.id}`)).messages.at(-1).body, /3211111111/);
  });

  test('a number sent by WhatsApp is not read as a price', async () => {
    const req = await buyer.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 2, city: 'Lahore' });
    await sunCity.call('POST', '/api/whatsapp', { text: '0300 2222222' });
    const reply = (await sunCity.call('GET', '/api/whatsapp')).at(-1).body;
    assert.match(reply, /Phone numbers can’t be shared/);
    assert.ok(!(await buyer.call('GET', `/api/requests/${req.id}`)).quotes.some((q) => q.supplier.id === 3 && q.price > 1e9));
  });

  test('the Kainat team sees attempts per business, and the number itself is never stored', async () => {
    const list = await admin.call('GET', '/api/admin/businesses?role=supplier');
    assert.ok(list.find((b) => b.name === 'Sun City Traders').number_attempts >= 3);
    assert.equal(list.find((b) => b.name === 'Green Volt Wholesale').number_attempts, 0);
    const o = await admin.call('GET', '/api/admin/overview');
    assert.ok(o.counts.number_attempts >= 5);
    // The recorded attempts never include the number itself.
    assert.ok(sql(srv, 'SELECT * FROM contact_attempts').every((a) => !Object.values(a).some((v) => /\d{10}/.test(String(v)))));
    await rejects(buyer.call('GET', '/api/admin/businesses'), 403);
  });
});
