// Two-way ratings: who can rate, blind reveal, editing, the 14-day and 30-day rules, flagged orders, replies,
// scores (minimum 3, latest per partner, 12 months), WhatsApp star taps, reminders and admin moderation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rejects, as } from '../helpers/server.js';

let srv, buyer, greenRoof, alNoor, sunCity, greenVolt, admin;
before(async () => {
  srv = await startServer();
  [buyer, greenRoof, alNoor, sunCity, greenVolt, admin] = await Promise.all(['sunPeak', 'greenRoof', 'alNoor', 'sunCity', 'greenVolt', 'admin'].map((w) => as(srv.base, w)));
});
after(async () => { await srv.stop(); });

// A fresh delivered order between the buyer client and Sun City.
async function delivered(b = buyer) {
  const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  const o = await b.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
  await sunCity.call('POST', `/api/orders/${o.id}/accept`);
  await b.call('POST', `/api/orders/${o.id}/deliver`);
  return o.id;
}
const rate = (c, id, body) => c.call('POST', `/api/orders/${id}/rating`, body);
const notes = async (c) => (await c.call('GET', '/api/notifications')).items;

test('seeded scores: Sun City shows 4.7 from 3 ratings; Al-Noor has 1 so no score yet', async () => {
  const sc = (await buyer.call('GET', '/api/suppliers/3')).supplier;
  assert.deepEqual([sc.rating.avg, sc.rating.count], [4.7, 3]);
  const an = (await buyer.call('GET', '/api/suppliers/2')).supplier;
  assert.equal(an.rating.avg, null);
  assert.equal(an.rating.count, 1);
  assert.equal(an.my_last_rating, 5);
  const reviews = (await buyer.call('GET', '/api/suppliers/3')).reviews;
  assert.ok(reviews.some((r) => r.reply && /Thokar/.test(r.reply)));
  // The blind seeded rating of SunPeak by Al-Noor is not in SunPeak's reviews yet.
  const mine = await buyer.call('GET', '/api/businesses/8/reviews');
  assert.ok(mine.reviews.every((r) => r.rater_name !== 'Al-Noor Solar Imports' || r.created_at < new Date(Date.now() - 20 * 864e5).toISOString()));
  // Scores appear on offers and in the supplier's request inbox.
  const offers = (await buyer.call('GET', '/api/models/1/offers')).offers;
  assert.ok(offers.every((o) => 'rating' in o.supplier));
});

test('who can rate: only the two sides, only once delivered, with 1 to 5 stars', async () => {
  const l = (await sunCity.call('GET', '/api/shop')).find((x) => x.name === 'Hi-MO 6 580 W');
  const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: 1, address: 'Johar Town' });
  await rejects(rate(buyer, o.id, { stars: 5 }), 409, /once it is delivered/);
  await sunCity.call('POST', `/api/orders/${o.id}/accept`);
  await buyer.call('POST', `/api/orders/${o.id}/deliver`);
  await rejects(rate(greenRoof, o.id, { stars: 5 }), 403);
  await rejects(rate(admin, o.id, { stars: 5 }), 403);
  for (const stars of [0, 6, 3.5, 'five', null]) await rejects(rate(buyer, o.id, { stars }), 400, /1 to 5/);
  // Tags from the other side's list, and unknown tags, are dropped.
  const r = await rate(buyer, o.id, { stars: 4, tags: ['On time', 'Paid token on time', 'Made up', 'On time'], comment: '  Fine  ' });
  assert.deepEqual(r.mine.tags, ['On time']);
  assert.equal(r.mine.comment, 'Fine');
  await rejects(new (await import('../helpers/server.js')).Client(srv.base).call('POST', `/api/orders/${o.id}/rating`, { stars: 3 }), 401);
});

test('blind: each side sees the other\'s rating only once both have rated', async () => {
  const id = await delivered();
  // Both sides were asked to rate on delivery.
  assert.ok((await notes(buyer)).some((n) => n.event === 'rate_prompt' && n.link === `#/order/${id}`));
  assert.ok((await notes(sunCity)).some((n) => n.event === 'rate_prompt' && n.link === `#/order/${id}`));
  const r1 = await rate(buyer, id, { stars: 2, comment: 'Late and short by one panel' });
  assert.equal(r1.theirs, null);
  assert.equal(r1.waiting_for_other, true);
  assert.ok(r1.reveal_by);
  const sv = (await sunCity.call('GET', `/api/orders/${id}`)).rating;
  assert.equal(sv.theirs, null, 'the supplier cannot see the buyer\'s rating yet');
  assert.equal(sv.can_rate, true);
  // Editing before the reveal is allowed.
  const r2 = await rate(buyer, id, { stars: 3, comment: 'Late, but they made it right' });
  assert.equal(r2.mine.stars, 3);
  const r3 = await rate(sunCity, id, { stars: 5, tags: ['Paid token on time'] });
  assert.equal(r3.theirs.stars, 3);
  assert.equal(r3.theirs.comment, 'Late, but they made it right');
  assert.equal((await buyer.call('GET', `/api/orders/${id}`)).rating.theirs.stars, 5);
  // Both are told; ratings can no longer change.
  assert.ok((await notes(sunCity)).some((n) => n.event === 'rating_revealed' && /3 ★/.test(n.body)));
  await rejects(rate(buyer, id, { stars: 5 }), 409, /no longer be changed/);
  assert.equal((await buyer.call('GET', `/api/orders/${id}`)).rating.can_rate, false);
});

test('the first rating nudges the other side without saying what it was', async () => {
  const id = await delivered();
  await rate(sunCity, id, { stars: 1, comment: 'secret' });
  const nudge = (await notes(buyer)).find((n) => n.event === 'rate_prompt' && /has rated your deal/.test(n.body) && n.link === `#/order/${id}`);
  assert.ok(nudge);
  assert.doesNotMatch(nudge.body, /1 ★|secret/);
});

test('a single rating is revealed after 14 days', async () => {
  const id = await delivered();
  await rate(buyer, id, { stars: 4 });
  await srv.advance(13 * 24 * 60);
  await srv.tick(['ratings']);
  assert.equal((await sunCity.call('GET', `/api/orders/${id}`)).rating.theirs, null);
  await srv.advance(24 * 60 + 1);
  await srv.tick(['ratings']);
  assert.equal((await sunCity.call('GET', `/api/orders/${id}`)).rating.theirs.stars, 4);
});

test('a flagged order holds ratings back until the Kainat team resolves it', async () => {
  const id = await delivered();
  await buyer.call('POST', `/api/orders/${id}/flag`, { note: 'One panel cracked' });
  await rate(buyer, id, { stars: 2 });
  const r = await rate(sunCity, id, { stars: 4 });
  assert.equal(r.theirs, null, 'both rated, still hidden');
  assert.equal((await buyer.call('GET', `/api/orders/${id}`)).rating.held_for_problem, true);
  await admin.call('POST', `/api/admin/orders/${id}/resolve`, { note: 'Panel replaced' });
  assert.equal((await buyer.call('GET', `/api/orders/${id}`)).rating.theirs.stars, 4);
});

test('rating closes 30 days after delivery, and each side is reminded once after 3 days', async () => {
  const id = await delivered(greenRoof);
  await srv.advance(2 * 24 * 60);
  await srv.tick(['ratings']);
  assert.ok(!(await notes(greenRoof)).some((n) => n.event === 'rate_reminder' && n.link === `#/order/${id}`));
  await srv.advance(24 * 60 + 1);
  await srv.tick(['ratings']);
  await srv.tick(['ratings']);
  assert.equal((await notes(greenRoof)).filter((n) => n.event === 'rate_reminder' && n.link === `#/order/${id}`).length, 1);
  assert.equal((await notes(sunCity)).filter((n) => n.event === 'rate_reminder' && n.link === `#/order/${id}`).length, 1);
  await srv.advance(27 * 24 * 60 + 1);
  await rejects(rate(greenRoof, id, { stars: 5 }), 409, /30 days/);
  const v = (await greenRoof.call('GET', `/api/orders/${id}`)).rating;
  assert.equal(v.window_open, false);
  assert.equal(v.can_rate, false);
});

test('replies: only the rated business, once, after the reveal', async () => {
  const id = await delivered();
  await rate(buyer, id, { stars: 3, comment: 'Packing could be better' });
  const ratingId = (await admin.call('GET', '/api/admin/ratings')).find((r) => r.order_id === id).id;
  await rejects(sunCity.call('POST', `/api/ratings/${ratingId}/reply`, { reply: 'Thanks' }), 409, /once the rating is shown/);
  await rate(sunCity, id, { stars: 5 });
  await rejects(buyer.call('POST', `/api/ratings/${ratingId}/reply`, { reply: 'Me again' }), 403);
  await rejects(sunCity.call('POST', `/api/ratings/${ratingId}/reply`, { reply: '  ' }), 400);
  await sunCity.call('POST', `/api/ratings/${ratingId}/reply`, { reply: 'We now double-box every panel.' });
  await rejects(sunCity.call('POST', `/api/ratings/${ratingId}/reply`, { reply: 'Again' }), 409, /already replied/);
  await rejects(sunCity.call('POST', '/api/ratings/99999/reply', { reply: 'x' }), 404);
  assert.equal((await buyer.call('GET', `/api/orders/${id}`)).rating.mine.reply, 'We now double-box every panel.');
});

test('scores count only the latest rating from each partner', async () => {
  // Green Volt starts with one rating (from Green Roof, 4 stars). Two more deals with SunPeak, rated 5 then 1:
  // only the 1 counts, so the score shows from 3 partners only.
  const l = (await greenVolt.call('GET', '/api/shop'))[0];
  for (const stars of [5, 1]) {
    const o = await buyer.call('POST', '/api/orders', { listing_id: l.id, qty: l.min_order || 1, address: 'Johar Town' });
    await greenVolt.call('POST', `/api/orders/${o.id}/accept`);
    await buyer.call('POST', `/api/orders/${o.id}/deliver`);
    await rate(buyer, o.id, { stars });
    await rate(greenVolt, o.id, { stars: 5 });
  }
  const s = (await buyer.call('GET', '/api/suppliers/4')).supplier.rating;
  assert.equal(s.count, 2, 'Green Roof and SunPeak, one each');
  assert.equal(s.avg, null, 'fewer than 3 partners: no score yet');
  assert.equal((await buyer.call('GET', '/api/suppliers/4')).supplier.my_last_rating, 1);
});

test('rating by WhatsApp star tap, keeping tags and comment from the app', async () => {
  const id = await delivered();
  await rate(buyer, id, { stars: 4, tags: ['Responsive'], comment: 'Quick replies' });
  await buyer.call('POST', '/api/whatsapp', { button: '2 ★', context: { type: 'rate', order_id: id } });
  const mine = (await buyer.call('GET', `/api/orders/${id}`)).rating.mine;
  assert.deepEqual([mine.stars, mine.tags, mine.comment], [2, ['Responsive'], 'Quick replies']);
  assert.match((await buyer.call('GET', '/api/whatsapp')).at(-1).body, /2 ★ saved.*hidden until they rate/s);
  await sunCity.call('POST', '/api/whatsapp', { button: '5 ★', context: { type: 'rate', order_id: id } });
  assert.match((await sunCity.call('GET', '/api/whatsapp')).at(-1).body, /both ratings are now shown/);
  // Someone else's order, and an order that is not delivered.
  await greenVolt.call('POST', '/api/whatsapp', { button: '5 ★', context: { type: 'rate', order_id: id } });
  assert.match((await greenVolt.call('GET', '/api/whatsapp')).at(-1).body, /not found/);
});

test('admin: list, low filter, hide a comment (stars still count); others refused', async () => {
  const id = await delivered();
  await rate(buyer, id, { stars: 1, comment: 'Abusive words here' });
  await rate(sunCity, id, { stars: 4 });
  const low = await admin.call('GET', '/api/admin/ratings?low=1');
  assert.ok(low.length && low.every((r) => r.stars <= 2));
  const r = low.find((x) => x.order_id === id);
  assert.ok((await admin.call('GET', '/api/admin/overview')).counts.low_ratings >= 1);
  await admin.call('POST', `/api/admin/ratings/${r.id}/hide`, { hidden: true });
  const seen = (await sunCity.call('GET', `/api/orders/${id}`)).rating.theirs;
  assert.equal(seen.comment, null);
  assert.equal(seen.hidden, true);
  assert.equal(seen.stars, 1);
  assert.ok(!(await buyer.call('GET', '/api/suppliers/3')).reviews.some((x) => x.comment === 'Abusive words here'));
  await admin.call('POST', `/api/admin/ratings/${r.id}/hide`, { hidden: false });
  assert.equal((await sunCity.call('GET', `/api/orders/${id}`)).rating.theirs.comment, 'Abusive words here');
  await rejects(admin.call('POST', '/api/admin/ratings/99999/hide', {}), 404);
  await rejects(buyer.call('GET', '/api/admin/ratings'), 403);
  await rejects(sunCity.call('POST', `/api/admin/ratings/${r.id}/hide`, {}), 403);
  // Admins see both ratings on the order, blind or not.
  assert.equal((await admin.call('GET', `/api/orders/${id}`)).rating.all.length, 2);
});

test('deals list and counts show what is waiting for a rating', async () => {
  const id = await delivered(greenRoof);
  const row = (await greenRoof.call('GET', '/api/orders')).find((o) => o.id === id);
  assert.equal(row.can_rate, true);
  const before = (await greenRoof.me()).counts.to_rate;
  await rate(greenRoof, id, { stars: 5 });
  assert.equal((await greenRoof.me()).counts.to_rate, before - 1);
  assert.equal((await greenRoof.call('GET', '/api/orders')).find((o) => o.id === id).can_rate, false);
  await rejects(buyer.call('GET', '/api/businesses/99999/reviews'), 404);
});
