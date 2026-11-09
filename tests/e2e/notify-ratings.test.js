// Browser tests for notifications (bell, list, alert settings, widening a request) and ratings (rating form,
// blind reveal, replies, scores on profiles, best-rated sort, admin moderation and logs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, toast, noErrors, waitText, noHorizontalScroll, accessibleNames } from './browser.js';

let srv, browser;
before(async () => { srv = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.stop(); });

test('the bell shows unread alerts; opening the list marks them read and each alert opens its screen', async () => {
  const b = await as(srv.base, 'sunPeak');
  const r = await b.call('POST', '/api/requests', { model_id: (await b.call('GET', '/api/catalog?q=growatt 10000'))[0].id, qty: 2, city: 'Lahore', scope: 'all' });
  const page = await openPage(browser, srv.base);
  await login(page, 'alNoor');
  const bell = page.locator('a.bell');
  await bell.waitFor();
  assert.match(await bell.getAttribute('aria-label'), /Notifications, \d+ unread/);
  await bell.click();
  await page.waitForURL(/#\/notifications/);
  await waitText(page, /In-stock match/);
  await noHorizontalScroll(page, 'notifications');
  await accessibleNames(page, 'notifications');
  // Opening marked everything read: the bell has no count now.
  assert.equal(await page.locator('a.bell .dot').count(), 0);
  await page.locator(`a.notif[href="#/s/quote/${r.id}"]`).first().click();
  await page.waitForURL(new RegExp(`#/s/quote/${r.id}`));
  noErrors(page);
});

test('alert settings: switch chat off and quiet hours off, and they stay saved', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'greenRoof');
  await go(page, '#/profile?tab=alerts');
  const f = page.locator('#np');
  assert.equal(await f.locator('[name=quiet_on]').isChecked(), false, 'tests run with quiet hours off by default');
  await f.locator('[name=quiet_on]').check();
  assert.equal(await page.locator('#qh').isVisible(), true);
  await f.locator('[name=quiet_start]').selectOption('23');
  await f.locator('[name=quiet_end]').selectOption('7');
  await f.locator('[name=wa_chat]').uncheck();
  await f.locator('button').click();
  assert.match(await toast(page), /Alert settings saved/);
  await go(page, '#/profile?tab=alerts&t=1');
  assert.equal(await page.locator('#np [name=wa_chat]').isChecked(), false);
  assert.equal(await page.locator('#np [name=quiet_start]').inputValue(), '23');
  assert.equal(await page.locator('#np [name=quiet_end]').inputValue(), '7');
  assert.equal(await page.locator('#np [name=wa_shop]').count(), 0, 'buyers have no price check setting');
  noErrors(page);
});

test('a buyer rates a deal: badge on deals, star form, both ratings shown, public reply', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  await go(page, '#/deals?tab=done');
  const card = page.locator('a.card', { hasText: 'Rate this deal' }).first();
  await card.click();
  await page.waitForSelector('#rate');
  await waitText(page, /How was dealing with Al-Noor/);
  // Submitting without stars is caught.
  await page.click('#rate button.primary');
  assert.match(await toast(page), /Choose 1 to 5 stars/);
  await page.click('label[for=st4]');
  await page.locator('#rate input[name=tags][value="Genuine stock"]').check();
  await page.fill('#rate textarea[name=comment]', 'Original Longi panels, <b>well packed</b>.');
  await page.click('#rate button.primary');
  // Al-Noor already rated this order, so both ratings show at once.
  assert.match(await toast(page), /Both ratings are now shown/);
  await waitText(page, /Al-Noor Solar Imports rated you/);
  assert.match(await page.locator('#rating').innerText(), /You rated them/);
  assert.equal(await page.locator('#rating b').count(), 0, 'comment HTML is shown as text');
  await page.click('[data-reply]');
  await page.fill('.modal textarea', 'Thank you, see you next order.');
  await page.click('.modal button.primary');
  assert.match(await toast(page), /Reply posted/);
  await waitText(page, /Reply: Thank you/);
  assert.equal(await page.locator('[data-reply]').count(), 0, 'one reply only');
  await accessibleNames(page, 'order rating');
  noErrors(page);
});

test('scores on the supplier profile and offers, and the best-rated sort', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'greenRoof');
  await go(page, '#/b/supplier/3');
  const t = await text(page);
  assert.match(t, /★ 4\.7/);
  assert.match(t, /Ratings from buyers/i);
  assert.match(t, /Thokar/);
  assert.match(t, /You rated them 4 ★ last time/);
  const m = (await (await as(srv.base, 'greenRoof')).call('GET', '/api/catalog?q=hi-mo'))[0];
  await go(page, `#/b/model/${m.id}?sort=rated`);
  const first = await page.locator('article.card').first().innerText();
  assert.match(first, /Sun City Traders/, 'the only supplier with a score comes first');
  assert.match(first, /★ 4\.7 · 3 ratings/);
  await noHorizontalScroll(page, 'best rated');
  noErrors(page);
});

test('the supplier sees the buyer\'s rating in the request inbox', async () => {
  const b = await as(srv.base, 'sunPeak');
  await b.call('POST', '/api/requests', { model_id: (await b.call('GET', '/api/catalog?q=pylontech us5000'))[0].id, qty: 1, city: 'Lahore', scope: 'all' });
  const page = await openPage(browser, srv.base);
  await login(page, 'sunCity');
  await go(page, '#/s/inbox');
  // SunPeak has ratings from Al-Noor and Sun City in the seed, plus the one just revealed.
  await waitText(page, /SunPeak Energy/);
  assert.match(await text(page), /rating/);
  noErrors(page);
});

test('no bids after 2 hours: the buyer widens the request to other cities', async () => {
  const b = await as(srv.base, 'brightWorks');
  const model = (await b.call('GET', '/api/catalog?q=inverex'))[0];
  const r = await b.call('POST', '/api/requests', { model_id: model.id, qty: 1, city: 'Lahore', scope: 'all' });
  await srv.advance(121);
  await srv.tick(['waves']);
  const page = await openPage(browser, srv.base);
  await login(page, 'brightWorks');
  await go(page, `#/b/request/${r.id}`);
  await waitText(page, /No bids yet/);
  await page.click('#widen');
  assert.match(await toast(page), /Sent to \d+ more supplier|No other supplier/);
  await waitText(page, /Abbas Solar Store/);
  noErrors(page);
});

test('admin: ratings with hide comment, notification log with filters', async () => {
  const page = await openPage(browser, srv.base, { width: 1280, height: 860 });
  await login(page, 'admin');
  await go(page, '#/a');
  assert.match(await text(page), /Low ratings to review/);
  await go(page, '#/a/ratings');
  const row = page.locator('tr', { hasText: 'Original Longi panels' });
  await row.locator('[data-hide]').click();
  assert.match(await toast(page), /Saved/);
  await waitText(page, /Hidden/);
  await go(page, '#/a/ratings?f=low');
  await go(page, '#/a/notifications');
  await waitText(page, /request match/);
  await page.click('a.chip:has-text("Sent")');
  await page.waitForURL(/s=sent/);
  await accessibleNames(page, 'admin notifications');
  noErrors(page);
});
