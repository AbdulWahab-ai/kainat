// End-to-end check of the main flows against a throwaway server and database.
// Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-procure-test-'));
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TEST_HOOKS: '1', DEFAULT_QUIET: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); passed++; console.log('  ok ' + msg); };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${method} ${p} -> ${res.status} ${data.error}`); e.status = res.status; throw e; }
    return data;
  }
  async login(phone) {
    const s = await this.call('POST', '/api/auth/start', { phone });
    await this.call('POST', '/api/auth/verify', { phone, code: s.devCode });
    return (await this.call('GET', '/api/me')).me;
  }
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not start');
}

try {
  await waitUp();
  console.log('Auth and onboarding');
  const buyer = new Client();
  const me = await buyer.login('0321-1111111');
  ok(me.role === 'buyer' && me.name === 'SunPeak Energy', 'demo buyer signs in with a formatted number');
  const fresh = new Client();
  const s = await fresh.call('POST', '/api/auth/start', { phone: '03451234567' });
  await fresh.call('POST', '/api/auth/verify', { phone: '03451234567', code: s.devCode });
  ok((await fresh.call('GET', '/api/me')).me.role === null, 'new number has no role yet');
  await fresh.call('POST', '/api/onboard', { role: 'supplier', name: 'Test Traders', city: 'Lahore', supplier_type: 'wholesaler' });
  ok((await fresh.call('GET', '/api/me')).me.role === 'supplier', 'new supplier can sign up');
  let badCode = false;
  try { await new Client().call('POST', '/api/auth/verify', { phone: '03001111111', code: '000000' }); } catch (e) { badCode = e.status === 400; }
  ok(badCode, 'wrong code is rejected');

  console.log('Search and price visibility');
  const results = await buyer.call('GET', '/api/search?q=growatt&instock=1&city=Lahore');
  ok(results.some((r) => r.model.name === 'SPF 10000 ES' && r.suppliers >= 3), 'search finds the Growatt 10 kW with several suppliers');
  const spf = results.find((r) => r.model.name === 'SPF 10000 ES').model;
  const offers = (await buyer.call('GET', `/api/models/${spf.id}/offers?city=Lahore`)).offers;
  ok(offers.every((o) => o.exact), 'verified buyer sees exact prices');
  const small = new Client();
  await small.login('03213333333');
  const offers2 = (await small.call('GET', `/api/models/${spf.id}/offers?city=Lahore`)).offers;
  const alNoorOffer = offers2.find((o) => o.supplier.name === 'Al-Noor Solar Imports');
  ok(alNoorOffer && !alNoorOffer.exact && alNoorOffer.low < alNoorOffer.high && alNoorOffer.price === undefined, 'unverified buyer sees a price range, not the exact price');
  ok(!alNoorOffer.supplier.phone, 'supplier phone hidden before any deal');

  console.log('Request, quote, order, delivery');
  const cat = await buyer.call('GET', '/api/catalog?q=US3000C');
  const req = await buyer.call('POST', '/api/requests', { model_id: cat[0].id, qty: 2, city: 'Lahore', scope: 'all' });
  ok(req.sent_to >= 1, `request sent to ${req.sent_to} supplier(s)`);
  const sup = new Client();
  await sup.login('03002222222');
  const inbox = await sup.call('GET', '/api/requests');
  ok(inbox.some((r) => r.id === req.id), 'matching supplier sees the request in the inbox');
  const wa = await sup.call('GET', '/api/whatsapp');
  ok(wa.some((m) => m.context?.request_id === req.id), 'supplier got the request on simulated WhatsApp');
  await sup.call('POST', `/api/requests/${req.id}/quote`, { price: 226000, qty: 5, token_pct: 20, lead_days: 1, share: true, visibility: 'exact' });
  const shop = await sup.call('GET', '/api/shop');
  ok(shop.some((l) => l.model_id === cat[0].id && l.price === 226000), 'shared quote updated the supplier shop');
  const rq = await buyer.call('GET', `/api/requests/${req.id}`);
  ok(rq.quotes.length === 1 && rq.quotes[0].price === 226000, 'buyer sees the quote');
  const order = await buyer.call('POST', '/api/orders', { quote_id: rq.quotes[0].id, qty: 2, address: 'Site 4, Johar Town, Lahore', token_proof: PNG });
  ok(order.id > 0, 'buyer orders from the quote with token proof');
  let tooMany = false;
  try { await buyer.call('POST', '/api/orders', { quote_id: rq.quotes[0].id, qty: 1, address: 'x' }); } catch (e) { tooMany = e.status === 409; }
  ok(tooMany, 'a request cannot be ordered twice');
  const before = (await buyer.call('GET', '/api/me')).me.deals;
  await sup.call('POST', `/api/orders/${order.id}/accept`);
  await sup.call('POST', `/api/orders/${order.id}/dispatch`);
  await buyer.call('POST', `/api/orders/${order.id}/messages`, { body: 'Thanks, site manager will receive' });
  await buyer.call('POST', `/api/orders/${order.id}/deliver`);
  const o = await buyer.call('GET', `/api/orders/${order.id}`);
  ok(o.status === 'delivered' && o.messages.length === 1 && o.token_proof, 'order goes accepted, dispatched, delivered with a message and proof');
  ok((await buyer.call('GET', '/api/me')).me.deals === before + 1, 'trade count goes up after delivery');
  const proof = await fetch(`${BASE}/api/orders/${order.id}/proof`, { headers: { cookie: buyer.cookie } });
  ok(proof.ok && proof.headers.get('content-type') === 'image/png', 'token proof is served to a party of the deal');
  const outsider = await fetch(`${BASE}/api/orders/${order.id}`, { headers: { cookie: small.cookie } });
  ok(outsider.status === 403, 'another buyer cannot open the order');

  console.log('WhatsApp quoting');
  const alNoor = new Client();
  await alNoor.login('03001111111');
  const openReq = (await alNoor.call('GET', '/api/requests')).find((r) => r.status === 'open' && r.target_status === 'sent' && r.name === 'US5000');
  ok(!!openReq, 'importer has the open battery request');
  await alNoor.call('POST', '/api/whatsapp', { button: 'Send price', context: { request_id: openReq.id } });
  await alNoor.call('POST', '/api/whatsapp', { text: '3.05 lakh 8 25' });
  let msgs = await alNoor.call('GET', '/api/whatsapp');
  const ask = msgs.at(-1);
  ok(ask.buttons?.includes('Yes, add it') && /305,000/.test(ask.body), 'a WhatsApp reply in lakh becomes a quote of Rs 305,000');
  await alNoor.call('POST', '/api/whatsapp', { button: 'Yes, add it', context: ask.context });
  const l = (await alNoor.call('GET', '/api/shop')).find((x) => x.name === 'US5000');
  ok(l.price === 305000 && l.qty === 8 && l.visible === 1, 'tapping "Yes, add it" updates the shop listing');
  const pend = (await alNoor.call('GET', '/api/orders')).find((x) => x.status === 'pending');
  await alNoor.call('POST', '/api/whatsapp', { button: 'Decline', context: { type: 'order', order_id: pend.id } });
  await alNoor.call('POST', '/api/whatsapp', { text: 'Out of stock until Monday' });
  ok((await alNoor.call('GET', `/api/orders/${pend.id}`)).status === 'declined', 'an order can be declined from WhatsApp with a reason');

  console.log('Admin builds a shop, supplier claims it');
  const admin = new Client();
  await admin.login('03000000000');
  const models = await admin.call('GET', '/api/admin/models');
  const us5000 = models.find((m) => m.name === 'US5000');
  const built = await admin.call('POST', '/api/admin/suppliers', { name: 'Fresh Batteries', phone: '03017777777', city: 'Lahore', supplier_type: 'importer',
    contact: 'Kamran', items: [{ model_id: us5000.id, price: 299000, qty: 30, token_pct: 20, visibility: 'band' }] });
  ok(built.items === 1, 'admin builds a supplier shop with an item');
  ok(built.requests_waiting >= 1, 'matching open requests are sent to the new shop');
  const newSup = new Client();
  const nm = await newSup.login('03017777777');
  ok(nm.role === 'supplier' && nm.claimed === false, 'team-built supplier signs in to an unclaimed shop');
  await newSup.call('POST', '/api/claim');
  ok((await newSup.call('GET', '/api/me')).me.claimed === true, 'supplier claims the shop');
  await admin.call('PUT', `/api/admin/businesses/${nm.id}`, { status: 'suspended' });
  let blocked = false;
  try { await newSup.call('GET', '/api/shop'); } catch (e) { blocked = e.status === 401 || e.status === 403; }
  ok(blocked, 'suspended account is signed out');
  const ov = await admin.call('GET', '/api/admin/overview');
  ok(ov.metrics.length === 7, 'admin overview returns the PRD metrics');
  const pc = await admin.call('POST', '/api/admin/price-check');
  ok(pc.sent >= 4, 'morning price check goes to suppliers with listings');
  await sup.call('POST', '/api/whatsapp', { button: 'Yes, same', context: { type: 'pricecheck' } });
  ok((await sup.call('GET', '/api/me')).counts.unconfirmed_today === 0, '"Yes, same" confirms every price for today');

  console.log('In-stock matching and live bidding');
  const br = await buyer.call('POST', '/api/requests', { model_id: spf.id, qty: 3, city: 'Lahore', scope: 'all', bidding: 'open' });
  ok(br.in_stock >= 3, `request for the Growatt 10 kW finds ${br.in_stock} suppliers with it in stock`);
  const anRow = (await alNoor.call('GET', '/api/requests')).find((r) => r.id === br.id);
  ok(anRow?.in_stock?.in_stock === 1 && anRow.in_stock.stock_price > 0, 'supplier inbox flags the in-stock match with their shop price');
  const anWa = (await alNoor.call('GET', '/api/whatsapp')).filter((m) => m.context?.request_id === br.id).at(-1);
  ok(anWa?.buttons?.[0]?.startsWith('Bid Rs') && /In-stock match/.test(anWa.body), 'in-stock supplier gets a one-tap "Bid Rs …" on WhatsApp');
  const ib = await alNoor.call('POST', `/api/requests/${br.id}/instant-bid`);
  ok(ib.board.my_rank === 1 && ib.board.count === 1 && ib.board.lowest === ib.quote.price, 'one-tap bid at the shop price takes first place');
  const brightSup = new Client();
  await brightSup.login('03004444444');
  const bWa = (await brightSup.call('GET', '/api/whatsapp')).filter((m) => m.context?.request_id === br.id).at(-1);
  await brightSup.call('POST', '/api/whatsapp', { button: bWa.buttons[0], context: bWa.context });
  const bBoard = await brightSup.call('GET', `/api/requests/${br.id}/board`);
  ok(bBoard.my_rank === 1 && bBoard.count === 2, 'a cheaper one-tap bid from WhatsApp takes the lead');
  const outbid = (await alNoor.call('GET', '/api/whatsapp')).at(-1);
  ok(/outbid/.test(outbid.body) && outbid.buttons.includes('Lower my bid'), 'the supplier who lost first place is told they were outbid');
  await alNoor.call('POST', `/api/requests/${br.id}/quote`, { price: bBoard.lowest - 2000, qty: 10, token_pct: 20, lead_days: 1, share: false });
  const view = await buyer.call('GET', `/api/requests/${br.id}`);
  ok(view.quotes[0].supplier.name === 'Al-Noor Solar Imports' && view.quotes[0].revisions === 2 && view.quotes[0].first_price > view.quotes[0].price,
    'a revised bid goes back to first place and the buyer sees how far it dropped');
  ok((await alNoor.call('GET', `/api/requests/${br.id}/board`)).my_rank === 1, 'supplier board shows them back at #1');
  const sealed = await buyer.call('POST', '/api/requests', { model_id: cat[0].id, qty: 1, city: 'Lahore', scope: 'all', bidding: 'sealed' });
  await sup.call('POST', `/api/requests/${sealed.id}/quote`, { price: 225000, qty: 3 });
  const sb = await sup.call('GET', `/api/requests/${sealed.id}/board`);
  ok(sb.mode === 'sealed' && sb.lowest === undefined && sb.my_price === 225000, 'sealed bidding hides other bids from suppliers');

  console.log('Chat');
  const chats = await buyer.call('GET', '/api/chats');
  const reqChat = chats.find((c) => c.request_id === br.id && c.other.name === 'Al-Noor Solar Imports');
  ok(!!reqChat, 'each bid opens a chat between buyer and supplier for that request');
  const thread = await buyer.call('GET', `/api/chats/${reqChat.id}`);
  ok(thread.messages.filter((m) => m.kind === 'bid').length === 2, 'the chat shows both bids from that supplier');
  await buyer.call('POST', `/api/chats/${reqChat.id}/messages`, { body: 'Can you deliver to DHA Phase 6 by Friday? Site photo attached.', attachment: PNG, attachment_name: 'site.png' });
  const anMe = await alNoor.call('GET', '/api/me');
  ok(anMe.counts.unread_chats >= 1, 'supplier sees an unread chat');
  ok((await alNoor.call('GET', '/api/notifications')).items.filter((n) => n.event === 'chat_message' && n.link === `#/chat/${reqChat.id}`).length === 1, 'supplier gets one chat nudge (WhatsApp now or in the next 15-minute batch)');
  const anThread = await alNoor.call('GET', `/api/chats/${reqChat.id}`);
  const fileMsg = anThread.messages.find((m) => m.has_file);
  const fileRes = await fetch(`${BASE}/api/chats/${reqChat.id}/files/${fileMsg.id}`, { headers: { cookie: alNoor.cookie } });
  ok(fileRes.ok && fileRes.headers.get('content-type') === 'image/png', 'chat attachment is served to the other party');
  ok((await alNoor.call('GET', '/api/me')).counts.unread_chats === 0, 'opening the chat marks it read');
  await alNoor.call('POST', `/api/chats/${reqChat.id}/messages`, { body: 'Yes, Friday morning works.' });
  ok((await buyer.call('GET', `/api/chats/${reqChat.id}?after=${anThread.messages.at(-1).id}`)).messages.length === 1, 'buyer receives the reply when polling for new messages');
  const peek = await fetch(`${BASE}/api/chats/${reqChat.id}`, { headers: { cookie: small.cookie } });
  ok(peek.status === 403, 'another buyer cannot read the chat');
  const abbasC = new Client();
  await abbasC.login('03005555555');
  let cold = false;
  try { await abbasC.call('POST', '/api/chats', { with_id: (await small.call('GET', '/api/me')).me.id }); } catch (e) { cold = e.status === 403; }
  ok(cold, 'a supplier cannot cold-message a buyer they have no request or order with');
  const abbasId = (await abbasC.call('GET', '/api/me')).me.id;
  const gc = await buyer.call('POST', '/api/chats', { with_id: abbasId });
  ok(gc.id > 0 && (await buyer.call('POST', '/api/chats', { with_id: abbasId })).id === gc.id, 'a buyer can message any supplier, and reopening returns the same chat');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\n' + e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => fs.rmSync(DATA, { recursive: true, force: true }), 300);
}
