// Opens every screen for every role, on a phone and on a desktop, and checks it renders cleanly:
// no script errors, no error page, no sideways scrolling, and every control has a readable name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, as } from '../helpers/server.js';
import { launch, openPage, login, go, text, noErrors, noHorizontalScroll, accessibleNames, MOBILE, DESKTOP } from './browser.js';

let srv, browser, ids = {};
before(async () => {
  srv = await startServer();
  browser = await launch();
  const b = await as(srv.base, 'sunPeak');
  const reqs = await b.call('GET', '/api/requests');
  ids.request = reqs[0].id;
  ids.quote = (await b.call('GET', `/api/requests/${ids.request}`)).quotes[0].id;
  ids.chat = (await b.call('GET', '/api/chats'))[0].id;
  ids.order = (await b.call('GET', '/api/orders'))[0].id;
  const s = await as(srv.base, 'alNoor');
  ids.listing = (await s.call('GET', '/api/shop'))[0].id;
  ids.sRequest = (await s.call('GET', '/api/requests'))[0].id;
  ids.sOrder = (await s.call('GET', '/api/orders')).find((o) => o.status === 'pending').id;
  ids.model = (await b.call('GET', '/api/catalog?q=SPF 10000'))[0].id;
  const sunCityListing = (await (await as(srv.base, 'sunCity')).call('GET', '/api/shop')).find((l) => l.visibility === 'exact');
  ids.exactListing = sunCityListing.id;
});
after(async () => { await browser?.close(); await srv?.stop(); });

const SCREENS = {
  anon: ['#/login'],
  buyer: () => ['#/b/search', '#/b/search?q=growatt&cat=inverter&instock=1&city=Lahore', `#/b/model/${ids.model}?city=Lahore`,
    `#/b/model/${ids.model}?sort=deals`, `#/b/model/${ids.model}?sort=fast`, '#/b/supplier/2', '#/b/request/new', `#/b/request/new?model=${ids.model}`,
    `#/b/request/new?listing=${ids.listing}`, '#/b/requests', `#/b/request/${ids.request}`, `#/b/order/new?quote=${ids.quote}`,
    `#/b/order/new?listing=${ids.exactListing}`, '#/deals', '#/deals?tab=done', '#/deals?tab=closed', `#/order/${ids.order}`, '#/chats', `#/chat/${ids.chat}`,
    '#/whatsapp', '#/profile'],
  supplier: () => ['#/s/inbox', '#/s/inbox?tab=quoted', '#/s/inbox?tab=orders', `#/s/quote/${ids.sRequest}`, '#/s/shop', `#/s/listing/${ids.listing}`,
    '#/s/add', '#/deals', `#/order/${ids.sOrder}`, '#/chats', '#/whatsapp', '#/profile'],
  admin: ['#/a', '#/a/suppliers', '#/a/buyers', '#/a/suppliers/new', '#/a/requests', '#/a/orders', '#/a/orders?f=disputed', '#/a/models', '#/a/whatsapp', '#/profile'],
};

async function checkAll(page, list, label) {
  for (const hash of list) {
    await go(page, hash);
    const body = await text(page);
    assert.doesNotMatch(body, /Something went wrong/, `${label} ${hash}`);
    assert.ok(body.trim().length > 20, `${label} ${hash} rendered content`);
    await noHorizontalScroll(page, `${label} ${hash}`);
    await accessibleNames(page, `${label} ${hash}`);
  }
  noErrors(page);
}

for (const [vpName, vp] of [['phone', MOBILE], ['desktop', DESKTOP]]) {
  test(`signed-out screens render on ${vpName}`, async () => {
    const page = await openPage(browser, srv.base, vp);
    await page.goto('/#/login');
    await checkAll(page, SCREENS.anon, 'anon');
    await page.close();
  });
  test(`every buyer screen renders on ${vpName}`, async () => {
    const page = await openPage(browser, srv.base, vp);
    await login(page, 'sunPeak');
    await checkAll(page, SCREENS.buyer(), 'buyer');
    await page.close();
  });
  test(`every supplier screen renders on ${vpName}`, async () => {
    const page = await openPage(browser, srv.base, vp);
    await login(page, 'alNoor');
    await checkAll(page, SCREENS.supplier(), 'supplier');
    await page.close();
  });
  test(`every admin screen renders on ${vpName}`, async () => {
    const page = await openPage(browser, srv.base, vp);
    await login(page, 'admin');
    await checkAll(page, SCREENS.admin, 'admin');
    await page.close();
  });
}

test('onboarding screens render: welcome, both sign-up forms, and claim your shop', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, '03465550000');
  assert.match(page.url(), /#\/welcome/);
  await checkAll(page, ['#/welcome', '#/signup/buyer', '#/signup/supplier'], 'new');
  const p2 = await openPage(browser, srv.base);
  await login(p2, 'newEra');
  assert.match(p2.url(), /#\/claim/);
  await checkAll(p2, ['#/claim'], 'unclaimed');
});

test('broken links: an unknown request, order or chat shows a friendly error page, not a blank screen', async () => {
  const page = await openPage(browser, srv.base);
  await login(page, 'sunPeak');
  for (const h of ['#/b/request/99999', '#/order/99999', '#/chat/99999', '#/b/model/99999', '#/b/supplier/99999']) {
    await go(page, h);
    const body = await text(page);
    assert.match(body, /Something went wrong/, h);
    assert.match(body, /Go home/, h);
  }
  noErrors(page);
});
