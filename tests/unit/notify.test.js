// Unit tests for the clock (Pakistan time), quiet hours and notification links. Uses a throwaway database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kainat-notify-'));
const clock = await import('../../src/clock.js');
const { inQuiet, linkFor, EVENTS, WA_GROUPS } = await import('../../src/notify.js');
const { TAGS, STAR_BUTTONS } = await import('../../src/ratings.js');

const at = (iso) => Date.parse(iso);

test('Pakistan hour and date are UTC+5 with no daylight saving', () => {
  assert.equal(clock.pktHour(at('2026-06-01T18:59:00Z')), 23);
  assert.equal(clock.pktHour(at('2026-06-01T19:00:00Z')), 0);
  assert.equal(clock.pktDate(at('2026-06-01T19:00:00Z')), '2026-06-02');
  assert.equal(clock.pktHour(at('2026-01-15T03:00:00Z')), 8);
});

test('nextPktHour finds the next time the Pakistan clock shows that hour', () => {
  assert.equal(new Date(clock.nextPktHour(8, at('2026-06-01T18:00:00Z'))).toISOString(), '2026-06-02T03:00:00.000Z');
  assert.equal(new Date(clock.nextPktHour(8, at('2026-06-02T02:00:00Z'))).toISOString(), '2026-06-02T03:00:00.000Z');
  // Exactly at the hour means the next day.
  assert.equal(new Date(clock.nextPktHour(8, at('2026-06-02T03:00:00Z'))).toISOString(), '2026-06-03T03:00:00.000Z');
});

test('quiet hours across midnight and within a day', () => {
  const night = { quiet_start: 22, quiet_end: 8 };
  assert.equal(inQuiet(night, at('2026-06-01T17:00:00Z')), true); // 22:00
  assert.equal(inQuiet(night, at('2026-06-01T16:59:00Z')), false); // 21:59
  assert.equal(inQuiet(night, at('2026-06-01T22:00:00Z')), true); // 03:00
  assert.equal(inQuiet(night, at('2026-06-02T03:00:00Z')), false); // 08:00
  const lunch = { quiet_start: 13, quiet_end: 14 };
  assert.equal(inQuiet(lunch, at('2026-06-01T08:30:00Z')), true); // 13:30
  assert.equal(inQuiet(lunch, at('2026-06-01T09:00:00Z')), false); // 14:00
  assert.equal(inQuiet({ quiet_start: null, quiet_end: null }), false);
});

test('the test clock can be set and moved forward', () => {
  clock.setClock({ set: '2030-01-01T00:00:00Z' });
  assert.ok(Math.abs(clock.nowMs() - at('2030-01-01T00:00:00Z')) < 1000);
  clock.setClock({ advanceMs: clock.HOUR });
  assert.ok(Math.abs(clock.nowMs() - at('2030-01-01T01:00:00Z')) < 1000);
  clock.setClock({ set: new Date().toISOString() });
});

test('links open the right screen for each kind of alert and role', () => {
  assert.equal(linkFor({ order_id: 5 }, 'buyer'), '#/order/5');
  assert.equal(linkFor({ conversation_id: 9 }, 'supplier'), '#/chat/9');
  assert.equal(linkFor({ request_id: 3 }, 'supplier'), '#/s/quote/3');
  assert.equal(linkFor({ request_id: 3 }, 'buyer'), '#/b/request/3');
  assert.equal(linkFor({ type: 'pricecheck' }, 'supplier'), '#/s/shop');
  assert.equal(linkFor({ type: 'digest' }, 'buyer'), '#/notifications');
  assert.equal(linkFor(null, 'buyer'), null);
});

test('every event has a known group and priority; orders always bypass quiet hours', () => {
  for (const [name, ev] of Object.entries(EVENTS)) {
    assert.ok(['urgent', 'normal'].includes(ev.priority), name);
    assert.ok([...WA_GROUPS, 'orders', 'account'].includes(ev.grp), name);
  }
  assert.equal(EVENTS.order_new.bypassQuiet, true);
  assert.ok(!WA_GROUPS.includes('orders'), 'orders cannot be switched off');
});

test('rating tags differ by side and star buttons run 5 to 1', () => {
  assert.ok(TAGS.buyer.includes('Genuine stock') && !TAGS.supplier.includes('Genuine stock'));
  assert.ok(TAGS.supplier.includes('Paid token on time'));
  assert.deepEqual(STAR_BUTTONS.map((b) => Number(b[0])), [5, 4, 3, 2, 1]);
});
