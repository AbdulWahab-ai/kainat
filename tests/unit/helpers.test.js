// Unit tests for the server's pure helper functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kainat-unit-'));
const { _internals: h } = await import('../../src/api.js');

test('normPhone accepts every common way of writing a Pakistani mobile number', () => {
  for (const v of ['03001234567', '0300 1234567', '0300-1234567', '+92 300 1234567', '923001234567', '00923001234567', '3001234567', ' (0300) 123-4567 ']) {
    assert.equal(h.normPhone(v), '03001234567', v);
  }
});

test('normPhone leaves invalid input invalid rather than guessing', () => {
  assert.equal(h.normPhone(''), '');
  assert.equal(h.normPhone(null), '');
  assert.equal(h.normPhone('abc'), '');
  assert.equal(h.normPhone('0300123'), '0300123');
  assert.equal(h.normPhone('92300123'), '92300123');
});

test('int parses numbers with commas and rounds', () => {
  assert.equal(h.int('1,234'), 1234);
  assert.equal(h.int('12.6'), 13);
  assert.equal(h.int(5), 5);
  assert.equal(h.int('0'), 0);
  assert.equal(h.int('-3'), -3);
});

test('int returns the default for empty, blank and non-numeric input', () => {
  assert.equal(h.int(undefined, 7), 7);
  assert.equal(h.int(null, 7), 7);
  assert.equal(h.int('', 7), 7);
  assert.equal(h.int('   ', 7), 7);
  assert.equal(h.int('abc', 7), 7);
  assert.equal(h.int('Infinity', 7), 7);
});

test('str trims, caps length and turns empty into null', () => {
  assert.equal(h.str('  hi  '), 'hi');
  assert.equal(h.str('   '), null);
  assert.equal(h.str(''), null);
  assert.equal(h.str(undefined), null);
  assert.equal(h.str(42), '42');
  assert.equal(h.str('abcdef', 3), 'abc');
});

test('band gives a range around the price, rounded to Rs 1,000', () => {
  const [lo, hi] = h.band(325000);
  assert.equal(lo, 312000);
  assert.equal(hi, 338000);
  for (const p of [1, 999, 17400, 612000]) {
    const [l, u] = h.band(p);
    assert.ok(l <= p && p <= u, `${p} inside [${l}, ${u}]`);
    assert.equal(l % 1000, 0);
    assert.equal(u % 1000, 0);
  }
});

test('cityMatch checks the home city and the delivery list, ignoring case and spaces', () => {
  const s = { city: 'Lahore', delivery_cities: 'Lahore, Faisalabad ,Gujranwala' };
  assert.ok(h.cityMatch(s, 'lahore'));
  assert.ok(h.cityMatch(s, ' Faisalabad '));
  assert.ok(h.cityMatch(s, 'GUJRANWALA'));
  assert.ok(!h.cityMatch(s, 'Lah'));
  assert.ok(!h.cityMatch(s, 'Multan'));
  assert.ok(h.cityMatch(s, ''));
  assert.ok(h.cityMatch(s, null));
  assert.ok(h.cityMatch({ city: 'Sahiwal', delivery_cities: null }, 'sahiwal'));
});

test('parseQuoteText reads price, quantity and token from WhatsApp-style replies', () => {
  assert.deepEqual(h.parseQuoteText('305000 8 20'), { price: 305000, qty: 8, token_pct: 20 });
  assert.deepEqual(h.parseQuoteText('3.05 lakh 8 25'), { price: 305000, qty: 8, token_pct: 25 });
  assert.deepEqual(h.parseQuoteText('2,99,000 10'), { price: 299000, qty: 10, token_pct: undefined });
  assert.equal(h.parseQuoteText('Rs. 300000').price, 300000);
  assert.equal(h.parseQuoteText('rs305000').price, 305000);
  assert.equal(h.parseQuoteText('300k').price, 300000);
  assert.equal(h.parseQuoteText('3 lac').price, 300000);
  assert.equal(h.parseQuoteText('Price is 3 lakh, 12 pcs, 20%').qty, 12);
  assert.equal(h.parseQuoteText('3,05,000/- 8 pcs 20%').token_pct, 20);
});

test('parseQuoteText returns null when there is no number', () => {
  assert.equal(h.parseQuoteText('hello'), null);
  assert.equal(h.parseQuoteText(''), null);
});

test('leadText says same-day for zero and pluralises days', () => {
  assert.equal(h.leadText(0), 'same-day delivery');
  assert.equal(h.leadText(1), 'delivery in 1 day');
  assert.equal(h.leadText(3), 'delivery in 3 days');
});

test('dayLabel formats dates and handles missing ones', () => {
  assert.equal(h.dayLabel(null), 'no date');
  assert.equal(h.dayLabel('2026-11-07'), '7 Nov');
});

test('staleDays counts whole days since a timestamp', () => {
  assert.equal(h.staleDays(new Date().toISOString()), 0);
  assert.equal(h.staleDays(new Date(Date.now() - 3.5 * 864e5).toISOString()), 3);
});

test('rs formats rupees with Pakistani grouping', () => {
  assert.match(h.rs(325000), /^Rs 3,25,000$|^Rs 325,000$/);
});
