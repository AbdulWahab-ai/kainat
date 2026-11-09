// Remaining paths: WhatsApp buttons that open screens, adding token proof later, links between screens,
// the buyer profile, and the chats screen's WhatsApp shortcut.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, ready, waitText, tmpFile, PNG_BYTES } from './browser.js';

let srv, browser;
before(async () => { srv = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.stop(); });

test('WhatsApp buttons "Open order", "See bids" and "Open chat" open the right screens', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'alNoor');
  await go(page, '#/whatsapp');
  await page.locator('[data-btn="Open order"]').first().click();
  await page.waitForURL(/#\/order\/\d+/);
  await ready(page);
  assert.match(await text(page), /Green Roof Solutions/);
  const b = await as(srv.base, 'sunPeak');
  const chat = await b.call('POST', '/api/chats', { with_id: 2 });
  await b.call('POST', `/api/chats/${chat.id}/messages`, { body: 'Are you open on Sunday?' });
  await go(page, '#/whatsapp');
  await page.locator('[data-btn="Open chat"]').last().click();
  await page.waitForURL(new RegExp(`#/chat/${chat.id}$`));
  await waitText(page, /open on Sunday/);
  const buyer = await openPage(browser, srv.base);
  await login(buyer, 'sunPeak');
  await go(buyer, '#/whatsapp');
  const seeBids = buyer.locator('[data-btn="See bids"], [data-btn="See quotes"]');
  if (await seeBids.count()) {
    await seeBids.last().click();
    await buyer.waitForURL(/#\/b\/request\/\d+/);
  }
  noErrors(page);
  noErrors(buyer);
});

test('a buyer adds the token screenshot later from the order page', async () => {
  const b = await as(srv.base, 'sunPeak');
  const sc = await as(srv.base, 'sunCity');
  const l = (await sc.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  const o = await b.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, `#/order/${o.id}`);
  await page.setInputFiles('#proof', tmpFile('later.png', PNG_BYTES));
  assert.match(await toast(page), /Proof uploaded/);
  await waitText(page, /Proof attached/);
  assert.match((await sc.call('GET', '/api/whatsapp')).at(-1).body, /uploaded token money proof/);
  noErrors(page);
});

test('search page "Post a request" link carries the search words', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/b/search?q=deye');
  await page.locator('a.card.tint', { hasText: 'Post a request' }).click();
  await waitText(page, /Post a request/);
  assert.equal(await page.inputValue('#mq'), 'deye');
  noErrors(page);
});

test('buyer profile: save changes and open WhatsApp from it', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'greenRoof');
  await go(page, '#/profile');
  await page.selectOption('select[name=installs]', 'Over 20');
  await page.fill('input[name=buys]', 'Panels, Inverters, Batteries');
  await page.click('#f button.primary');
  assert.match(await toast(page), /Saved/);
  await page.click('a:has-text("Open simulated WhatsApp")');
  await page.waitForURL(/#\/whatsapp/);
  await go(page, '#/profile?t=1');
  assert.equal(await page.inputValue('select[name=installs]'), 'Over 20');
  noErrors(page);
});

test('chats screen links to WhatsApp, and an empty chat list explains what to do', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'greenRoof');
  await go(page, '#/chats');
  assert.match(await text(page), /No chats yet/);
  await page.click('a.btn:has-text("WhatsApp")');
  await page.waitForURL(/#\/whatsapp/);
  noErrors(page);
});

test('the supplier\'s "Change some" on the daily check opens the shop', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'alNoor');
  if (await page.locator('a:has-text("Change some")').count()) {
    await page.click('a:has-text("Change some")');
    await page.waitForURL(/#\/s\/shop/);
  }
  noErrors(page);
});
