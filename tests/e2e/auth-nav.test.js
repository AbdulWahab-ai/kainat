// Sign-in, sign-up, claim your shop, navigation guards and switching accounts, all through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, ready } from './browser.js';

let srv, browser;
before(async () => { srv = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.stop(); });

test('each demo account lands on its own home screen with the right tabs', async () => {
  const cases = [
    ['alNoor', /#\/s\/inbox/, ['Requests', 'My shop', 'Deals', 'Chats', 'Profile']],
    ['sunPeak', /#\/b\/search/, ['Search', 'Requests', 'Deals', 'Chats', 'Profile']],
    ['admin', /#\/a$/, ['Overview', 'Suppliers', 'Buyers', 'Requests', 'Orders', 'Models', 'WhatsApp log']],
    ['newEra', /#\/claim/, []],
  ];
  for (const [who, url, tabs] of cases) {
    const page = await openPage(browser, srv.base);
    await login(page, who);
    assert.match(page.url(), url, who);
    const body = await text(page);
    for (const t of tabs) assert.ok(body.includes(t), `${who} sees ${t}`);
    noErrors(page);
    await page.close();
  }
});

test('typing a number by hand works, and a wrong code shows an error without signing in', async () => {
  const page = await openPage(browser, srv.base);
  await page.goto('/#/login');
  await page.fill('#phone', '0321 111 1111');
  await page.click('#f button.primary');
  await page.waitForSelector('#code');
  assert.match(await text(page), /\+92 321 1111111/);
  await page.fill('#code', '000000');
  await page.click('#f button.primary');
  assert.match(await toast(page), /not right/);
  assert.match(page.url(), /#\/otp/);
  await page.click('#fill');
  await page.waitForURL(/#\/b\/search/);
  noErrors(page);
});

test('an invalid phone number is refused on the sign-in page', async () => {
  const page = await openPage(browser, srv.base);
  await page.goto('/#/login');
  await page.fill('#phone', '12345');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Pakistani mobile number/);
  assert.match(page.url(), /#\/login/);
});

test('a new number signs up as a buyer through the form', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, '03331112222');
  assert.match(page.url(), /#\/welcome/);
  await page.click('a[href="#/signup/buyer"]');
  await page.waitForSelector('#f');
  await page.click('#f button.primary'); // empty name: the browser blocks it
  assert.match(page.url(), /signup\/buyer/);
  await page.fill('input[name=name]', 'E2E Installers');
  await page.fill('input[name=contact]', 'Zain');
  await page.check('input[name=buys][value=Batteries]');
  await page.click('#f button.primary');
  await page.waitForURL(/#\/b\/search/);
  await go(page, '#/profile');
  assert.equal(await page.inputValue('input[name=name]'), 'E2E Installers');
  assert.equal(await page.inputValue('input[name=buys]'), 'Batteries');
  noErrors(page);
});

test('a new number signs up as a supplier and lands on an empty request inbox', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, '03331113333');
  await page.click('a[href="#/signup/supplier"]');
  await page.fill('input[name=name]', 'E2E Traders');
  await page.check('input[name=supplier_type][value=importer]');
  await page.fill('input[name=delivery_cities]', 'Lahore, Kasur');
  await page.click('#f button.primary');
  await page.waitForURL(/#\/s\/inbox/);
  await ready(page);
  assert.match(await text(page), /E2E Traders/);
  await go(page, '#/whatsapp');
  assert.match(await text(page), /Welcome to the marketplace|Welcome/);
  noErrors(page);
});

test('"Use a different number" on the welcome screen signs out', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, '03331114444');
  await page.click('#out');
  await page.waitForURL(/#\/login/);
});

test('claiming a team-built shop', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'newEra');
  const body = await text(page);
  assert.match(body, /Your shop is ready/);
  assert.match(body, /buyer request/);
  assert.match(body, /items already listed/i);
  await page.click('#claim');
  await page.waitForURL(/#\/s\/inbox/);
  await login(page, 'newEra');
  assert.match(page.url(), /#\/s\/inbox/, 'a claimed shop goes straight to the inbox next time');
  noErrors(page);
});

test('guards: signed-out users go to sign-in, and each role is kept out of the others\' screens', async () => {
  const anon = await openPage(browser, srv.base);
  for (const h of ['#/b/search', '#/s/inbox', '#/a', '#/chats', '#/order/1']) {
    await anon.goto('/' + h);
    await anon.waitForURL(/#\/login/);
  }
  const buyer = await openPage(browser, srv.base);
  await login(buyer, 'sunPeak');
  for (const h of ['#/s/inbox', '#/s/shop', '#/a', '#/a/suppliers', '#/claim']) {
    await buyer.evaluate((x) => { location.hash = x; }, h);
    await buyer.waitForURL(/#\/b\/search/);
  }
  const sup = await openPage(browser, srv.base);
  await login(sup, 'alNoor');
  for (const h of ['#/b/search', '#/b/requests', '#/a/models']) {
    await sup.evaluate((x) => { location.hash = x; }, h);
    await sup.waitForURL(/#\/s\/inbox/);
  }
  await sup.evaluate(() => { location.hash = '#/no/such/page'; });
  await sup.waitForURL(/#\/s\/inbox/);
  noErrors(buyer);
  noErrors(sup);
});

test('switching accounts from the top bar', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await page.click('#switch-account');
  await page.waitForURL(/#\/login/);
  await page.waitForSelector('#switch-account', { state: 'hidden' });
  await login(page, 'alNoor');
  assert.match(page.url(), /#\/s\/inbox/);
});

test('signing out from the profile page', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'greenRoof');
  await go(page, '#/profile');
  await page.click('#out');
  await page.waitForURL(/#\/login/);
  await page.goto('/#/b/search');
  await page.waitForURL(/#\/login/);
});

test('a session ended on the server (suspension) sends the user back to sign-in', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'greenVolt');
  const admin = await openPage(browser, srv.base, { width: 1280, height: 860 });
  await login(admin, 'admin');
  await admin.evaluate(() => fetch('/api/admin/businesses/4', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"status":"suspended"}' }));
  await go(page, '#/s/shop');
  await page.waitForURL(/#\/login/);
  await admin.evaluate(() => fetch('/api/admin/businesses/4', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"status":"active"}' }));
});
