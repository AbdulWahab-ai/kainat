// Supplier workflows through the real UI: inbox, instant bid, bidding and beating, passing, shop editing,
// adding items, the simulated WhatsApp, handling orders, chatting with buyers and the profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, ready, waitText } from './browser.js';

let srv, browser, buyer, M;
before(async () => {
  srv = await startServer();
  browser = await launch();
  buyer = await as(srv.base, 'sunPeak');
  M = Object.fromEntries((await buyer.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
});
after(async () => { await browser?.close(); await srv?.stop(); });

const newRequest = (body) => buyer.call('POST', '/api/requests', { city: 'Lahore', scope: 'all', ...body });

test('inbox: tabs, in-stock badge and one-tap bid', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'alNoor');
  let body = await text(page);
  assert.match(body, /In stock in your shop: 18/);
  assert.match(body, /ORDER TO CONFIRM|Order to confirm/i);
  await page.click('a.chip[href="#/s/inbox?tab=quoted"]');
  await ready(page);
  await page.click('a.chip[href="#/s/inbox?tab=orders"]');
  await ready(page);
  assert.match(await text(page), /Green Roof Solutions/);
  await page.click('a.chip[href="#/s/inbox?tab=open"]');
  await ready(page);
  await page.locator('[data-instant]').first().click();
  assert.match(await toast(page), /Bid placed\. You are #1 of 3/);
  await page.click('a.chip[href="#/s/inbox?tab=quoted"]');
  await waitText(page, /Your bid: Rs (325,000|3,25,000) × 18 · #1 of 3/);
  noErrors(page);
});

test('bid screen: live board, "Beat the lowest", bid history and the board updating by itself', async () => {
  const r = await newRequest({ model_id: M['Growatt SPF 10000 ES'], qty: 2 });
  const gv = await as(srv.base, 'greenVolt');
  await gv.call('POST', `/api/requests/${r.id}/quote`, { price: 320000, qty: 5 });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunCity');
  await go(page, `#/s/quote/${r.id}`);
  assert.match(await page.locator('#board').innerText(), /1\s*bids?[\s\S]*320,000/);
  await page.click('#beat');
  assert.equal(await page.inputValue('input[name=price]'), '319000');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Bid placed/);
  await ready(page);
  assert.match(await page.locator('#board').innerText(), /#1/);
  // Another supplier undercuts; the board refreshes without reloading.
  await gv.call('POST', `/api/requests/${r.id}/quote`, { price: 310000, qty: 5 });
  await page.waitForFunction(() => /#2/.test(document.querySelector('#board')?.innerText || ''), null, { timeout: 9000 });
  assert.match(await page.locator('#board').innerText(), /310,000/);
  await page.fill('input[name=price]', '309000');
  await page.click('#f button.primary');
  await toast(page);
  await ready(page);
  assert.match(await text(page), /Your bid history/);
  noErrors(page);
});

test('bid screen refuses an empty price and a closed request', async () => {
  const r = await newRequest({ model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  const page = await openPage(browser, srv.base);
  await login(page, 'greenVolt');
  await go(page, `#/s/quote/${r.id}`);
  await page.fill('input[name=price]', '');
  await page.click('#f button.primary');
  assert.match(page.url(), new RegExp(`#/s/quote/${r.id}$`), 'the browser blocks an empty required price');
  await buyer.call('POST', `/api/requests/${r.id}/cancel`);
  await go(page, `#/s/quote/${r.id}?t=1`);
  assert.match(await text(page), /This request is cancelled\. You can no longer bid/);
  assert.equal(await page.locator('#f button.primary').isDisabled(), true);
});

test('a free-text request makes the supplier pick a model', async () => {
  const r = await newRequest({ category: 'battery', description: '5 kWh lithium', qty: 2 });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunCity');
  await go(page, `#/s/quote/${r.id}`);
  await page.fill('#mq', 'US3000');
  await page.waitForSelector('#mres [data-id]');
  await page.locator('#mres [data-id]').first().click();
  await page.fill('input[name=price]', '227000');
  await page.click('#f button.primary');
  assert.match(await toast(page), /added to your shop/);
  const q = (await buyer.call('GET', `/api/requests/${r.id}`)).quotes[0];
  assert.equal(q.model.name, 'US3000C');
});

test('"Not in stock" removes the request from the open tab', async () => {
  const r = await newRequest({ model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  const page = await openPage(browser, srv.base);
  await login(page, 'bright');
  const before = await page.locator('[data-pass]').count();
  await page.locator(`[data-pass="${r.id}"]`).click();
  assert.match(await toast(page), /not in stock/);
  await ready(page);
  assert.equal(await page.locator('[data-pass]').count(), before - 1);
});

test('shop: confirm all, edit a price (history updates), hide and show an item', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'alNoor');
  await go(page, '#/s/shop');
  if (await page.locator('#keep').count()) {
    await page.click('#keep');
    assert.match(await toast(page), /prices confirmed/);
    await ready(page);
  }
  await page.locator('a.card', { hasText: 'Hi-MO 6 580 W' }).click();
  await ready(page);
  await page.fill('input[name=price]', '16900');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Saved/);
  await ready(page);
  assert.match(await text(page), /Rs 16,900/);
  await page.locator('a.card', { hasText: 'Hi-MO 6 580 W' }).click();
  await ready(page);
  assert.match(await text(page), /PRICE HISTORY[\s\S]*16,900/i);
  await page.uncheck('input[name=visible]');
  await page.click('#f button.primary');
  await toast(page);
  await ready(page);
  assert.match(await page.locator('a.card', { hasText: 'Hi-MO 6 580 W' }).innerText(), /Hidden/);
  await page.locator('a.card', { hasText: 'Hi-MO 6 580 W' }).click();
  await ready(page);
  await page.check('input[name=visible]');
  await page.click('#f button.primary');
  await toast(page);
  noErrors(page);
});

test('adding an item from the catalogue, and submitting a brand-new model', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'abbas');
  await go(page, '#/s/add');
  await page.fill('#mq', 'Dyness');
  await page.locator('#mres [data-id]').first().click();
  await page.fill('#f input[name=price]', '96000');
  await page.fill('#f input[name=qty]', '12');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Added to your shop/);
  await ready(page);
  assert.match(await text(page), /B4850/);
  await go(page, '#/s/add');
  await page.click('details summary');
  await page.selectOption('#nm select[name=category]', 'inverter');
  await page.fill('#nm input[name=brand]', 'Knox');
  await page.fill('#nm input[name=name]', 'Hybrid 8kW');
  await page.click('#nm button');
  await page.waitForSelector('#f:not(.hidden)');
  assert.match(await page.locator('#sel').innerText(), /Knox Hybrid 8kW \(awaiting approval\)/);
  await page.fill('#f input[name=price]', '150000');
  await page.click('#f button.primary');
  await toast(page);
  await ready(page);
  assert.match(await text(page), /Model awaiting approval/);
  // Adding the same model twice is refused with a clear message.
  await go(page, '#/s/add');
  await page.fill('#mq', 'Dyness');
  await page.locator('#mres [data-id]').first().click();
  await page.fill('#f input[name=price]', '1');
  await page.click('#f button.primary');
  assert.match(await toast(page), /already in your shop/);
  noErrors(page);
});

test('simulated WhatsApp: tap "Bid lower", type a price, add it to the shop', async () => {
  const r = await newRequest({ model_id: M['Pylontech US3000C'], qty: 2 });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunCity');
  await go(page, '#/whatsapp');
  const btn = page.locator('[data-btn="Bid lower"]').last();
  await btn.click();
  await ready(page);
  await page.fill('#send input[name=text]', '2.25 lakh 4 20');
  await page.click('#send button');
  await ready(page);
  await page.waitForSelector('[data-btn="Yes, add it"]');
  assert.match(await text(page), /Quote sent to SunPeak Energy: Pylontech US3000C at Rs 225,000|2,25,000/);
  await page.locator('[data-btn="Yes, add it"]').last().click();
  await waitText(page, /Added to your shop/);
  const q = (await buyer.call('GET', `/api/requests/${r.id}`)).quotes.find((x) => x.supplier.name === 'Sun City Traders');
  assert.equal(q.price, 225000);
  await page.locator('[data-btn="Open request"], [data-btn="See bids"]').count();
  noErrors(page);
});

test('orders: decline with a reason in the dialog, accept another, then dispatch', async () => {
  const sc = await as(srv.base, 'sunCity');
  const l = (await sc.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  const o1 = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 2, address: 'DHA Phase 6' });
  const o2 = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'DHA Phase 6' });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunCity');
  await go(page, `#/order/${o1.id}`);
  await page.click('[data-act=decline]');
  await page.click('#modal-root [data-cancel]');
  assert.equal(await page.locator('#modal-root .modal').count(), 0, 'cancel closes the dialog without declining');
  await page.click('[data-act=decline]');
  await page.fill('#modal-root textarea', 'Out of stock until Monday');
  await page.click('#modal-root button.primary');
  assert.match(await toast(page), /declined/);
  await ready(page);
  assert.match(await text(page), /Reason: Out of stock until Monday/);
  await go(page, `#/order/${o2.id}`);
  await page.click('[data-act=accept]');
  assert.match(await toast(page), /accepted/);
  await ready(page);
  await page.click('[data-act=dispatch]');
  assert.match(await toast(page), /dispatched/);
  await ready(page);
  assert.equal(await page.locator('[data-act]').filter({ hasText: /Accept|Dispatch/ }).count(), 0);
  await page.fill('#msg input[name=body]', 'Truck leaves at 10');
  await page.click('#msg button');
  await waitText(page, /Truck leaves at 10/);
  noErrors(page);
});

test('chatting with a buyer from the inbox "Ask" button', async () => {
  await newRequest({ model_id: M['Growatt SPF 10000 ES'], qty: 1 });
  const page = await openPage(browser, srv.base);
  await login(page, 'greenVolt');
  await page.locator('a.btn', { hasText: 'Ask' }).first().click();
  await page.waitForURL(/#\/chat\/\d+/);
  await ready(page);
  await page.fill('#send input[name=body]', 'Do you need the WiFi dongle as well?');
  await page.click('#send button.primary');
  await page.waitForFunction(() => /WiFi dongle/.test(document.querySelector('#thread').innerText));
  const chats = await buyer.call('GET', '/api/chats');
  assert.ok(chats.some((c) => c.last?.body === 'Do you need the WiFi dongle as well?'));
  noErrors(page);
});

test('profile: edit and save', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'abbas');
  await go(page, '#/profile');
  await page.fill('input[name=contact]', 'Abbas Ali');
  await page.fill('input[name=delivery_cities]', 'Sahiwal, Okara, Pakpattan, Arifwala');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Saved/);
  await go(page, '#/profile?t=1');
  assert.equal(await page.inputValue('input[name=contact]'), 'Abbas Ali');
  noErrors(page);
});
