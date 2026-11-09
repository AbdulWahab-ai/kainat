// Browser tests for the security screens: the phone-number warning in chat and on orders, hidden numbers on order
// and supplier pages, signing out on all devices, and the production sign-in page without demo accounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, waitText, accessibleNames, noHorizontalScroll } from './browser.js';

let srv, browser;
before(async () => { srv = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.stop(); });

test('chat: typing a number warns at once; sending shows the risk warning; edit or send without the number', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/chat/new?with=3');
  await page.waitForSelector('#send');
  const input = page.locator('#send input[name=body]');
  await input.fill('Sir mera number 0300 1234567 hai');
  assert.equal(await page.locator('#numhint').isVisible(), true, 'the hint shows while typing');
  assert.match(await input.getAttribute('class'), /flagged/);
  await page.click('#send button.primary');
  const dlg = page.locator('[role=alertdialog]');
  await dlg.waitFor();
  const words = await dlg.innerText();
  assert.match(words, /Phone numbers stay off Kainat/);
  assert.match(words, /the risk goes with it/);
  assert.match(words, /can also harm Sun City Traders’s profile/);
  assert.match(words, /•••• •••••••/, 'the preview hides the number');
  await accessibleNames(page, 'number warning');
  await page.click('[data-v=edit]');
  assert.equal(await input.inputValue(), 'Sir mera number 0300 1234567 hai', 'Edit keeps the message');
  await page.click('#send button.primary');
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Repeated attempts are reviewed/, 'second attempt');
  await page.click('[data-v=mask]');
  await waitText(page, /Sir mera number \[number hidden\] hai/);
  await waitText(page, /phone number was removed from this message/);
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('#numhint').isVisible(), false);
  noErrors(page);
});

test('the supplier sees the warning about their own profile', async () => {
  const b = await as(srv.base, 'sunPeak');
  const { id } = await b.call('POST', '/api/chats', { with_id: 2 });
  await b.call('POST', `/api/chats/${id}/messages`, { body: 'Is the Growatt in stock?' });
  const page = await openPage(browser, srv.base);
  await login(page, 'alNoor');
  await go(page, `#/chat/${id}`);
  await page.fill('#send input[name=body]', 'Yes, call me on 0300 1111111');
  await page.click('#send button.primary');
  const dlg = page.locator('[role=alertdialog]');
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /can harm your supplier profile/);
  noErrors(page);
});

test('order page: no phone number for the other side, a private note and a Message button; order messages are guarded too', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/order/1');
  const t = await text(page);
  assert.doesNotMatch(t, /0300 ?1111111|03001111111/);
  assert.match(t, /Number hidden/);
  assert.equal(await page.locator('a.btn:has-text("Message")').count(), 1);
  await page.fill('#msg input[name=body]', 'please call 03211111111');
  assert.equal(await page.locator('#ordhint').isVisible(), true);
  await page.click('#msg button');
  await page.locator('[role=alertdialog]').waitFor();
  await page.click('[data-v=mask]');
  await waitText(page, /please call \[number hidden\]/);
  await noHorizontalScroll(page, 'order page');
  noErrors(page);
});

test('supplier profile tells the buyer that numbers stay private and offers a message link', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/b/supplier/2');
  const t = await text(page);
  assert.match(t, /Phone numbers stay private on Kainat/);
  assert.doesNotMatch(t, /03001111111/);
  noErrors(page);
});

test('sign out on all devices asks first, then signs out everywhere', async () => {
  const other = await as(srv.base, 'greenRoof');
  const page = await openPage(browser, srv.base);
  await login(page, 'greenRoof');
  await go(page, '#/profile');
  await page.click('#outall');
  await page.locator('.modal').waitFor();
  await page.click('.modal [data-yes]');
  await page.waitForURL(/#\/login/);
  const r = await other.raw('GET', '/api/orders');
  assert.equal(r.status, 401, 'the other device was signed out too');
  noErrors(page);
});

test('a production sign-in page shows no demo accounts', async () => {
  const prod = await startServer({ NODE_ENV: 'production' });
  try {
    const page = await openPage(browser, prod.base);
    await page.goto('/#/login');
    await page.waitForSelector('#phone');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-phone]').count(), 0);
    assert.doesNotMatch(await text(page), /Demo accounts/);
    noErrors(page);
  } finally { await prod.stop(); }
});
