// Unit tests for the browser helpers in public/js/core.js (they need no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../../public/js/core.js');

test('esc escapes every HTML special character', () => {
  assert.equal(c.esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(c.esc(null), '');
  assert.equal(c.esc(undefined), '');
  assert.equal(c.esc(0), '0');
});

test('rs and num format money', () => {
  assert.match(c.rs(325000), /^Rs 3,25,000$|^Rs 325,000$/);
  assert.equal(c.num(null), '0');
});

test('priceText shows an exact price or a range', () => {
  assert.match(c.priceText({ exact: true, price: 1000 }), /^Rs 1,000$/);
  assert.match(c.priceText({ exact: false, low: 1000, high: 2000 }), /^Rs 1,000 – 2,000$/);
});

test('plural and phoneText', () => {
  assert.equal(c.plural(1, 'deal'), '1 deal');
  assert.equal(c.plural(0, 'deal'), '0 deals');
  assert.equal(c.plural(3, 'bid'), '3 bids');
  assert.equal(c.phoneText('03001234567'), '+92 300 1234567');
  assert.equal(c.phoneText('123'), '123');
});

test('ago and until describe times relative to now', () => {
  assert.equal(c.ago(new Date().toISOString()), 'just now');
  assert.equal(c.ago(new Date(Date.now() - 5 * 60000).toISOString()), '5 min ago');
  assert.equal(c.ago(new Date(Date.now() - 3 * 3600000).toISOString()), '3 h ago');
  assert.equal(c.ago(new Date(Date.now() - 30 * 3600000).toISOString()), 'yesterday');
  assert.equal(c.ago(new Date(Date.now() - 4 * 864e5).toISOString()), '4 days ago');
  assert.equal(c.ago(''), '');
  assert.equal(c.until(new Date(Date.now() - 1000).toISOString()), 'closed');
  assert.equal(c.until(new Date(Date.now() + 10 * 60000).toISOString()), 'closes in 10 min');
  assert.equal(c.until(new Date(Date.now() + 47.6 * 3600000).toISOString()), 'closes in 48 h');
});

test('freshness flags prices not confirmed for more than 2 days', () => {
  const now = new Date().toISOString();
  assert.equal(c.freshness(0, now).cls, '');
  assert.equal(c.freshness(2, now).cls, '');
  assert.equal(c.freshness(3, now).cls, 'amber');
  assert.match(c.freshness(5, now).text, /5 days/);
});

test('homeFor sends each role to the right first screen', () => {
  assert.equal(c.homeFor(null), '#/login');
  assert.equal(c.homeFor({ role: null }), '#/welcome');
  assert.equal(c.homeFor({ role: 'admin', is_admin: true }), '#/a');
  assert.equal(c.homeFor({ role: 'supplier', claimed: false }), '#/claim');
  assert.equal(c.homeFor({ role: 'supplier', claimed: true }), '#/s/inbox');
  assert.equal(c.homeFor({ role: 'buyer' }), '#/b/search');
});

test('statusBadge labels every status and flags disputes', () => {
  for (const s of ['pending', 'accepted', 'dispatched', 'delivered', 'declined', 'cancelled', 'open', 'ordered', 'expired', 'quoted', 'passed', 'sent']) {
    assert.match(c.statusBadge(s), /class="badge/);
  }
  assert.match(c.statusBadge('pending'), /Waiting for supplier/);
  assert.match(c.statusBadge('delivered', 1), /Problem flagged/);
});

test('bizBadges shows trade history, new-supplier warning and verified', () => {
  assert.match(c.bizBadges({ with_you: 2, deals: 5 }), /You: 2 deals/);
  assert.match(c.bizBadges({ with_you: 1, deals: 5 }), /You: 1 deal</);
  assert.match(c.bizBadges({ with_you: 0, deals: 0 }), /New · 0 deals/);
  assert.match(c.bizBadges({ with_you: 0, deals: 3, verified: true }), /Verified/);
  assert.doesNotMatch(c.bizBadges({ with_you: 0, deals: 3 }), /New/);
});
