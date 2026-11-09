// Buyer workflows through the real UI: search, compare, exact-price requests, posting requests, live bids,
// ordering with an uploaded screenshot, delivery, problems, cancelling, invites and chat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, ready, waitText, tmpFile, PNG_BYTES } from './browser.js';

let srv, browser, M;
before(async () => {
  srv = await startServer();
  browser = await launch();
  const b = await as(srv.base, 'sunPeak');
  M = Object.fromEntries((await b.call('GET', '/api/catalog')).map((m) => [`${m.brand} ${m.name}`, m.id]));
});
after(async () => { await browser?.close(); await srv?.stop(); });

test('search: typing, category, stock and city filters', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await page.fill('#sf input[name=q]', 'growatt');
  await page.press('#sf input[name=q]', 'Enter');
  await waitText(page, /3 MODELS MATCH/i);
  await page.click('a.chip:has-text("Batteries")');
  await waitText(page, /NO RESULTS|0 MODELS|Nothing matches/i);
  await page.click('a.chip:has-text("All")');
  await waitText(page, /MODELS MATCH/i);
  await page.click('a.chip:has-text("Lahore")');
  await waitText(page, /Any city/);
  await page.click('a.chip:has-text("In stock only")');
  await ready(page);
  assert.match(page.url(), /instock=0/);
  noErrors(page);
});

test('compare: sorting, the new-supplier warning and opening a supplier profile and chat', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/model/${M['Growatt SPF 10000 ES']}?city=Lahore`);
  const cards = () => page.locator('article.card').allInnerTexts();
  assert.match((await cards())[0], /Bright Power Co\.[\s\S]*New · 0 deals/);
  await page.click('a.chip:has-text("Most deals")');
  await ready(page);
  assert.match((await cards())[0], /Al-Noor Solar Imports/);
  await page.click('a.chip:has-text("Fastest")');
  await ready(page);
  assert.match((await cards())[0], /same day/);
  await page.locator('article.card a.strong', { hasText: 'Sun City Traders' }).first().click();
  await waitText(page, /deals on app/);
  await page.click('a.btn:has-text("Message")');
  await page.waitForURL(/#\/chat\/\d+/);
  await ready(page);
  assert.match(await text(page), /Sun City Traders/);
  noErrors(page);
});

test('an unverified buyer sees a range and gets the exact price by asking that supplier', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'brightWorks');
  await go(page, `#/b/model/${M['Growatt SPF 10000 ES']}?city=Lahore`);
  const card = page.locator('article.card', { hasText: 'Al-Noor Solar Imports' });
  assert.match(await card.innerText(), /Rs 312,000 – 338,000|3,12,000/);
  await card.locator('a:has-text("Get exact price")').click();
  await waitText(page, /Ask for the exact price/);
  await page.fill('#f input[name=qty]', '2');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Sent to 1 supplier/);
  await page.waitForURL(/#\/b\/request\/\d+/);
  await ready(page);
  const s = await as(srv.base, 'alNoor');
  const id = page.url().match(/request\/(\d+)/)[1];
  await s.call('POST', `/api/requests/${id}/instant-bid`);
  await waitText(page, /Rs 325,000|3,25,000/, 9000);
  noErrors(page);
});

let liveRequestId;
test('posting a request: in-stock suppliers are listed at once and bids appear live', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/request/new?model=${M['Growatt SPF 10000 ES']}`);
  assert.match(await page.locator('#pickhint').innerText(), /Selected: Growatt SPF 10000 ES/);
  await page.fill('#f input[name=qty]', '3');
  await page.check('input[name=bidding][value=open]');
  await page.click('#f button.primary');
  assert.match(await toast(page), /4 have it in stock now/);
  await page.waitForURL(/#\/b\/request\/\d+/);
  liveRequestId = page.url().match(/request\/(\d+)/)[1];
  await waitText(page, /IN STOCK RIGHT NOW, NOT BID YET/i);
  assert.match(await text(page), /No bids yet/);
  const sc = await as(srv.base, 'sunCity');
  await sc.call('POST', `/api/requests/${liveRequestId}/quote`, { price: 329000, qty: 6 });
  await waitText(page, /Best bid[\s\S]*Rs 329,000|3,29,000/, 9000);
  await sc.call('POST', `/api/requests/${liveRequestId}/quote`, { price: 322000, qty: 6 });
  await waitText(page, /down Rs 7,000/, 9000);
  noErrors(page);
});

test('posting a free-text request with "Any model" and sealed bidding', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/b/request/new?q=5 kWh lithium');
  await page.click('#mres [data-free]');
  await page.selectOption('#f select[name=category]', 'battery');
  assert.equal(await page.inputValue('#f input[name=description]'), '5 kWh lithium');
  await page.check('input[name=bidding][value=sealed]');
  await page.fill('#f input[name=qty]', '2');
  await page.click('#f button.primary');
  await page.waitForURL(/#\/b\/request\/\d+/);
  await waitText(page, /Sealed bids/);
  assert.match(await text(page), /5 kWh lithium × 2/);
  noErrors(page);
});

test('the request form refuses to send without picking a model or "Any model"', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/b/request/new');
  await page.fill('#mq', 'something odd');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Pick a model/);
  assert.match(page.url(), /request\/new/);
});

test('accepting a bid: order form, token calculation, new address, screenshot upload', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/request/${liveRequestId}`);
  await page.locator('a:has-text("Accept bid")').first().click();
  await waitText(page, /Confirm order/);
  await page.fill('#f input[name=qty]', '2');
  assert.match(await page.locator("#token").innerText(), /Rs (1,28,800|128,800)/); // 322,000 × 2 × 20% token
  await page.selectOption('#f select[name=addr]', '__new');
  await page.fill('#f input[name=address_new]', 'Plot 7, Bahria Town, Lahore');
  await page.fill('#f input[name=address_label]', 'Site: Bahria');
  await page.setInputFiles('#f input[name=proof]', tmpFile('token.png', PNG_BYTES));
  assert.match(await page.locator('#fname').innerText(), /token\.png/);
  await page.click('#f button.primary');
  await page.waitForURL(/#\/order\/\d+/);
  await waitText(page, /Proof attached/);
  assert.match(await text(page), /Waiting for supplier/);
  const img = await page.locator('img.proof-thumb').evaluate((el) => el.complete && el.naturalWidth > 0);
  assert.ok(img, 'the uploaded screenshot loads');
  await go(page, '#/b/order/new?quote=1');
  assert.match(await page.locator('#f select[name=addr]').innerText(), /Site: Bahria/, 'the new address was saved');
  noErrors(page);
});

test('delivery: supplier accepts, buyer confirms in the dialog, then flags a problem', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  const b = await as(srv.base, 'sunPeak');
  const o = (await b.call('GET', '/api/orders')).find((x) => x.status === 'pending');
  const sc = await as(srv.base, 'sunCity');
  await sc.call('POST', `/api/orders/${o.id}/accept`);
  await go(page, `#/order/${o.id}`);
  await page.click('[data-act=deliver]');
  await page.click('#modal-root [data-no]');
  assert.match(await text(page), /Accepted/);
  await page.click('[data-act=deliver]');
  await page.click('#modal-root [data-yes]');
  assert.match(await toast(page), /Delivery confirmed/);
  await waitText(page, /Delivered/);
  await page.click('[data-act=flag]');
  await page.fill('#modal-root textarea', 'One unit has a cracked screen');
  await page.click('#modal-root button.primary');
  await waitText(page, /Problem flagged[\s\S]*cracked screen/);
  noErrors(page);
});

test('cancelling an order placed from a bid gives the buyer the bids back', async () => {
  const b = await as(srv.base, 'sunPeak');
  const r = await b.call('POST', '/api/requests', { model_id: M['Growatt SPF 10000 ES'], qty: 1, city: 'Lahore' });
  const gv = await as(srv.base, 'greenVolt');
  await gv.call('POST', `/api/requests/${r.id}/quote`, { price: 331000, qty: 4 });
  const q = (await b.call('GET', `/api/requests/${r.id}`)).quotes[0];
  const o = await b.call('POST', '/api/orders', { quote_id: q.id, qty: 1, address: 'Johar Town' });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/order/${o.id}`);
  await page.click('[data-act=cancel]');
  await page.click('#modal-root [data-yes]');
  assert.match(await toast(page), /cancelled/);
  await go(page, `#/b/request/${r.id}`);
  assert.match(await text(page), /Accept bid/);
  noErrors(page);
});

test('inviting your own supplier, then cancelling the request', async () => {
  const b = await as(srv.base, 'sunPeak');
  const r = await b.call('POST', '/api/requests', { model_id: M['Narada 51.2V 100Ah'], qty: 2, city: 'Lahore' });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/request/${r.id}`);
  await page.click('summary:has-text("Invite my own supplier")');
  await page.fill('#inv input[name=name]', 'Cousin Solar');
  await page.fill('#inv input[name=phone]', '0302 1112223');
  await page.click('#inv button');
  assert.match(await toast(page), /Invite sent with this request/);
  await ready(page);
  await page.click('summary:has-text("Who received this request")');
  assert.match(await text(page), /Cousin Solar/);
  await page.click('#cancel');
  assert.match(await toast(page), /Request cancelled/);
  await page.waitForURL(/#\/b\/requests/);
  await ready(page);
  assert.match(await text(page), /Narada 51\.2V 100Ah × 2[\s\S]*Cancelled/);
  noErrors(page);
});

test('chat: open from a bid, send text and a photo, see the reply arrive', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/b/request/${liveRequestId}`);
  await page.locator('a:has-text("Chat with Sun City Traders")').click();
  await page.waitForURL(/#\/chat\/\d+/);
  await ready(page);
  assert.match(await text(page), /Revised bid: Rs 322,000|3,22,000/);
  await page.fill('#send input[name=body]', 'Here is the roof');
  await page.setInputFiles('#file', tmpFile('roof.png', PNG_BYTES));
  assert.match(await page.locator('#attname').innerText(), /roof\.png/);
  await page.click('#send button.primary');
  await page.waitForFunction(() => document.querySelectorAll('#thread img').length >= 1);
  const chatId = page.url().match(/chat\/(\d+)/)[1];
  const sc = await as(srv.base, 'sunCity');
  await sc.call('POST', `/api/chats/${chatId}/messages`, { body: 'Got it, ships tomorrow' });
  await page.waitForFunction(() => /ships tomorrow/.test(document.querySelector('#thread').innerText), null, { timeout: 8000 });
  await sc.call('POST', `/api/chats/${chatId}/messages`, { body: 'One more thing' });
  await go(page, '#/chats');
  await waitText(page, /One more thing/);
  assert.equal(await page.locator('a.card.accent').count() >= 1, true, 'the unread chat is highlighted');
  noErrors(page);
});

test('requests list shows bid counts, and the deals tabs work', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/b/requests');
  assert.match(await text(page), /bids? · best/);
  await go(page, '#/deals');
  await page.click('a.chip:has-text("Delivered")');
  await waitText(page, /Delivered/);
  await page.click('a.chip:has-text("Closed")');
  await ready(page);
  noErrors(page);
});
