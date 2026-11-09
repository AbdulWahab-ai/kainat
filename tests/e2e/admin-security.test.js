// Admin console workflows, plus security and regression checks across the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, ready, waitText, DESKTOP } from './browser.js';

let srv, browser, M;
before(async () => {
  srv = await startServer();
  browser = await launch();
  const b = await as(srv.base, 'sunPeak');
  M = Object.fromEntries((await b.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
});
after(async () => { await browser?.close(); await srv?.stop(); });

test('overview: metrics, counts and the morning price check', async () => {
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  const body = await text(page);
  for (const s of ['Suppliers', 'Buyers', 'Open requests', 'Documents to check', 'Success metrics', 'Median time from request to first quote']) assert.ok(body.includes(s), s);
  await page.click('#pc');
  assert.match(await toast(page), /Price check sent to \d+ supplier/);
  noErrors(page);
});

test('building a supplier shop through the form, then the supplier signs in to it', async () => {
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  await go(page, '#/a/suppliers/new');
  await page.fill('#f input[name=name]', 'Admin Built Solar');
  await page.fill('#f input[name=phone]', '0302 999 8888');
  await page.fill('#f input[name=contact]', 'Faisal');
  await page.selectOption('#f select[name=supplier_type]', 'importer');
  const rows = page.locator('#items tr');
  await rows.nth(0).locator('select[name=model_id]').selectOption(String(M['Pylontech US5000']));
  await rows.nth(0).locator('input[name=price]').fill('299000');
  await page.click('#add');
  assert.equal(await rows.count(), 4);
  await rows.nth(3).locator('[data-del]').click();
  assert.equal(await rows.count(), 3);
  await page.click('#f button.primary');
  assert.match(await toast(page), /Shop created with 1 item/);
  await waitText(page, /Admin Built Solar/);
  const s = await openPage(browser, srv.base);
  await login(s, '03029998888');
  assert.match(s.url(), /#\/claim/);
  assert.match(await text(s), /Admin Built Solar[\s\S]*1 items already listed/i);
  noErrors(page);
});

test('the build form shows an error for a number that already has an account', async () => {
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  await go(page, '#/a/suppliers/new');
  await page.fill('#f input[name=name]', 'Dup');
  await page.fill('#f input[name=phone]', '03001111111');
  await page.click('#f button.primary');
  assert.match(await toast(page), /already has an account/);
  assert.match(page.url(), /suppliers\/new/);
});

test('verifying, changing documents, suspending and reactivating a supplier', async () => {
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  await go(page, '#/a/suppliers');
  const row = page.locator('tr', { hasText: 'Green Volt Wholesale' });
  await row.locator('select[data-f=docs_status]').selectOption('verified');
  assert.match(await toast(page), /Saved/);
  await ready(page);
  await page.locator('tr', { hasText: 'Green Volt Wholesale' }).locator('input[data-f=verified]').check();
  await toast(page);
  await ready(page);
  await page.locator('tr', { hasText: 'Green Volt Wholesale' }).locator('button[data-f=status]').click();
  await waitText(page, /Reactivate/);
  await page.locator('tr', { hasText: 'Green Volt Wholesale' }).locator('button[data-f=status]').click();
  await ready(page);
  const r = await page.locator('tr', { hasText: 'Green Volt Wholesale' }).innerText();
  assert.match(r, /Suspend/);
  const a = await as(srv.base, 'admin');
  const gv = (await a.call('GET', '/api/admin/businesses')).find((b) => b.name === 'Green Volt Wholesale');
  assert.deepEqual([gv.docs_status, gv.verified, gv.status], ['verified', 1, 'active']);
  await go(page, '#/a/buyers');
  await page.locator('tr', { hasText: 'Bright Solar Works' }).locator('input[data-f=verified]').check();
  assert.match(await toast(page), /Saved/);
  noErrors(page);
});

test('catalogue: add, approve, merge and reject models', async () => {
  const sup = await as(srv.base, 'abbas');
  const p1 = await sup.call('POST', '/api/models', { category: 'battery', brand: 'NewCell', name: 'NC-5' });
  const p2 = await sup.call('POST', '/api/models', { category: 'battery', brand: 'Pylon Tech', name: 'US 5000' });
  const p3 = await sup.call('POST', '/api/models', { category: 'battery', brand: 'Junk', name: 'J1' });
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  await go(page, '#/a/models');
  await page.click('details summary');
  await page.selectOption('#nm select[name=category]', 'cable');
  await page.fill('#nm input[name=brand]', 'Fast Cables');
  await page.fill('#nm input[name=name]', 'AC 16mm');
  await page.click('#nm button');
  assert.match(await toast(page), /Model added/);
  await ready(page);
  await page.click(`[data-a=approve][data-id="${p1.id}"]`);
  await toast(page);
  await ready(page);
  await page.selectOption(`select[data-merge="${p2.id}"]`, String(M['Pylontech US5000']));
  assert.match(await toast(page), /Merged/);
  await ready(page);
  await page.click(`[data-a=reject][data-id="${p3.id}"]`);
  await toast(page);
  await ready(page);
  const models = await (await as(srv.base, 'admin')).call('GET', '/api/admin/models');
  const st = (id) => models.find((m) => m.id === id).status;
  assert.deepEqual([st(p1.id), st(p2.id), st(p3.id)], ['approved', 'rejected', 'rejected']);
  assert.ok(models.some((m) => m.name === 'AC 16mm' && m.status === 'approved'));
  noErrors(page);
});

test('orders: filter flagged problems and resolve one with a note', async () => {
  const b = await as(srv.base, 'greenRoof');
  const o = (await b.call('GET', '/api/orders'))[0];
  await b.call('POST', `/api/orders/${o.id}/flag`, { note: 'Short by 2 panels' });
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  await go(page, '#/a/orders?f=disputed');
  assert.match(await text(page), /Short by 2 panels/);
  await page.click(`[data-resolve="${o.id}"]`);
  await page.fill('#modal-root textarea', 'Supplier sent the missing panels');
  await page.click('#modal-root button.primary');
  assert.match(await toast(page), /resolved/);
  await ready(page);
  assert.doesNotMatch(await text(page), /Short by 2 panels/);
  await go(page, `#/order/${o.id}`);
  assert.match(await text(page), /Kainat team: Supplier sent the missing panels/);
  noErrors(page);
});

test('requests and WhatsApp log pages list data', async () => {
  const page = await openPage(browser, srv.base, DESKTOP);
  await login(page, 'admin');
  await go(page, '#/a/requests');
  assert.match(await text(page), /SunPeak Energy[\s\S]*Growatt SPF 10000 ES/);
  await go(page, '#/a/whatsapp');
  assert.match(await text(page), /In-stock match|New request/);
  noErrors(page);
});

// ---------- security and regressions ----------
test('HTML typed into names and messages is shown as text and never runs', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const c = await as(srv.base, '03035550001');
  await c.call('POST', '/api/onboard', { role: 'buyer', name: `Evil ${evil}`, city: 'Lahore' });
  const r = await c.call('POST', '/api/requests', { category: 'battery', description: `Need ${evil}`, qty: 1, city: 'Lahore' });
  const chat = await c.call('POST', '/api/chats', { with_id: 2, request_id: r.id });
  await c.call('POST', `/api/chats/${chat.id}/messages`, { body: `Hello ${evil}` });
  const sup = await openPage(browser, srv.base);
  await login(sup, 'alNoor');
  await waitText(sup, /Evil <img/);
  await go(sup, `#/chat/${chat.id}`);
  await waitText(sup, /Hello <img src=x/);
  await go(sup, '#/whatsapp');
  const admin = await openPage(browser, srv.base, DESKTOP);
  await login(admin, 'admin');
  await go(admin, '#/a/buyers');
  await go(admin, '#/a/requests');
  await go(admin, '#/a/whatsapp');
  for (const p of [sup, admin]) {
    assert.equal(await p.evaluate(() => window.__pwned), undefined, 'injected markup did not run');
    assert.equal(await p.locator('#app img[src="x"]').count(), 0);
  }
});

test('leaving a live screen does not pull the user back when the next update arrives', async () => {
  const b = await as(srv.base, 'sunPeak');
  const r = await b.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/request/${r.id}`);
  await go(page, '#/profile');
  const gv = await as(srv.base, 'greenVolt');
  await gv.call('POST', `/api/requests/${r.id}/quote`, { price: 330000, qty: 1 });
  await page.waitForTimeout(5500);
  assert.match(page.url(), /#\/profile$/, 'still on the profile');
  noErrors(page);
});

test('quickly switching screens never shows the wrong screen', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  for (const h of ['#/b/requests', '#/deals', '#/chats', '#/b/search', '#/profile']) await page.evaluate((x) => { location.hash = x; }, h);
  await ready(page);
  await page.waitForTimeout(800);
  assert.match(page.url(), /#\/profile$/);
  assert.match(await text(page), /Profile/);
  assert.doesNotMatch(await text(page), /Find equipment|My requests/);
  noErrors(page);
});

test('double-tapping "Place bid" sends only one bid', async () => {
  const b = await as(srv.base, 'sunPeak');
  const r = await b.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
  const page = await openPage(browser, srv.base);
  await login(page, 'greenVolt');
  await go(page, `#/s/quote/${r.id}`);
  await page.fill('input[name=price]', '333000');
  await page.locator('#f button.primary').dblclick();
  await page.waitForTimeout(1200);
  const gv = await as(srv.base, 'greenVolt');
  const d = await gv.call('GET', `/api/requests/${r.id}`);
  assert.equal(d.bid_history.length, 1, 'one bid recorded');
});

test('double-tapping "Send order" creates one order', async () => {
  const b = await as(srv.base, 'sunPeak');
  const before = (await b.call('GET', '/api/orders')).length;
  const sc = await as(srv.base, 'sunCity');
  const l = (await sc.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/order/new?listing=${l.id}`);
  await page.locator('#f button.primary').dblclick();
  await page.waitForURL(/#\/order\/\d+/);
  await page.waitForTimeout(800);
  assert.equal((await b.call('GET', '/api/orders')).length, before + 1);
});
