// Unit tests for phone-number detection and masking, and for checking uploads by their real content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { phoneIn, maskPhones, toLatin } from '../../public/js/phone.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kainat-phone-'));
const { sniffType } = await import('../../src/api.js');

const NUMBERS = ['0300 1234567', '03001234567', '+92 300 1234567', '0092-300-1234567', '3001234567', '0 3 0 0 1 2 3 4 5 6 7',
  '۰۳۰۰۱۲۳۴۵۶۷', '٠٣٠٠١٢٣٤٥٦٧', '042 35761234', 'wa.me/923001234567', 'https://api.whatsapp.com/send?phone=92300', 'call 0300.123.4567 now',
  'Sir mera number 0300 1234567 hai', '(0300) 123-4567', 'Rs 1312000 03001234567'];
const NOT_NUMBERS = ['Rs 325,000', '325000 8 20', '3.05 lakh 8', 'Order #9 for 40 panels', 'Total Rs 1,312,000', '2 lakh 50 hazar',
  'NTN 1234567-8', 'Rs 1312000 for 4', 'meet at 10:45', '4 x 328000 = 1312000', 'Growatt SPF 10000 ES', 'Longi Hi-MO 6 580 W', ''];

test('phone numbers in every common form are caught', () => {
  for (const t of NUMBERS) assert.equal(phoneIn(t), true, t);
});

test('prices, quantities, models and order numbers are not mistaken for phone numbers', () => {
  for (const t of NOT_NUMBERS) assert.equal(phoneIn(t), false, t);
});

test('masking replaces only the number and keeps the rest of the message', () => {
  assert.equal(maskPhones('Call me on 0321-4567890 for delivery'), 'Call me on [number hidden] for delivery');
  assert.equal(maskPhones('Price Rs 325,000, call 03001234567'), 'Price Rs 325,000, call [number hidden]');
  assert.equal(maskPhones('chat here wa.me/923001234567 ok'), 'chat here [number hidden] ok');
  assert.equal(maskPhones('No numbers here, 40 panels'), 'No numbers here, 40 panels');
  assert.equal(maskPhones('0300 1234567', '••••'), '••••');
  assert.equal(toLatin('۰۳۰۰'), '0300');
});

test('uploads are recognised by their first bytes, not their name', () => {
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0])), 'png');
  assert.equal(sniffType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])), 'jpg');
  assert.equal(sniffType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  assert.equal(sniffType(Buffer.from('%PDF-1.7\n')), 'pdf');
  assert.equal(sniffType(Buffer.from('<script>alert(1)</script>')), null);
  assert.equal(sniffType(Buffer.from('GIF89a')), null);
  assert.equal(sniffType(Buffer.alloc(0)), null);
});
