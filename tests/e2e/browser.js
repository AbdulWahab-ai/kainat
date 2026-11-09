// Browser helpers for end-to-end tests: launch Chromium, sign in through the real UI, and watch for errors.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PHONES } from '../helpers/server.js';

export const MOBILE = { width: 375, height: 812 };
export const DESKTOP = { width: 1280, height: 860 };

export function launch() {
  return chromium.launch({ headless: true });
}

// A fresh browser context (own cookies) with a page that records every script error.
export async function openPage(browser, base, viewport = MOBILE) {
  const context = await browser.newContext({ viewport, baseURL: base });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Expected 4xx responses (sign-out probes, refused actions) are logged by the browser as resource errors.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(`console: ${m.text()}`);
  });
  page.setDefaultTimeout(8000);
  return page;
}

export async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction(() => !document.querySelector('#app .loading'));
  await page.waitForTimeout(150);
}

// Signs in by tapping a demo account on the sign-in page and using the code shown on screen.
export async function login(page, who) {
  const phone = PHONES[who] || who;
  await page.goto('/#/login');
  const switcher = page.locator('#switch-account');
  if (await switcher.isVisible()) { await switcher.click(); await page.waitForURL(/#\/login/); }
  await page.waitForSelector('#phone');
  const demo = page.locator(`[data-phone="${phone}"]`);
  if (await demo.count()) await demo.click();
  else { await page.fill('#phone', phone); await page.click('#f button.primary'); }
  await page.waitForSelector('#fill');
  await page.click('#fill');
  await page.waitForFunction(() => !/#\/(otp|login)/.test(location.hash));
  await page.waitForFunction(() => !document.querySelector('#app .loading'));
}

export const text = (page) => page.locator('#app').innerText();
export async function toast(page) {
  await page.waitForSelector('#toast:not([hidden])');
  return page.locator('#toast').innerText();
}

// Fails the test if any script error happened on the page.
export function noErrors(page) {
  assert.deepEqual(page.errors, [], 'no script errors on the page');
}

// Fails if the page scrolls sideways at the current width.
export async function noHorizontalScroll(page, label = '') {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw + 1, `${label} scrolls sideways: ${sw} > ${iw}`);
}

// Every button and link needs a readable name, every image an alt attribute.
export async function accessibleNames(page, label = '') {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#app button, #app a[href]')) {
      const name = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.title || '').trim();
      if (!name && !el.closest('[hidden]')) out.push(el.outerHTML.slice(0, 120));
    }
    for (const img of document.querySelectorAll('#app img')) if (!img.hasAttribute('alt')) out.push(img.outerHTML.slice(0, 120));
    for (const input of document.querySelectorAll('#app input:not([type=hidden]), #app select, #app textarea')) {
      const labelled = input.labels?.length || input.getAttribute('aria-label') || input.closest('label') || input.type === 'file';
      if (!labelled) out.push(input.outerHTML.slice(0, 120));
    }
    return out;
  });
  assert.deepEqual(bad, [], `${label} has unlabelled controls`);
}

export function tmpFile(name, content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kainat-e2e-')), name);
  fs.writeFileSync(p, content);
  return p;
}
export const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// Waits until the current screen has finished loading.
export async function ready(page) {
  // Actions reload the screen after an API call; give that a moment to start before waiting for it to finish.
  await page.waitForTimeout(350);
  await page.waitForFunction(() => !document.querySelector('#app .loading') && document.querySelector('#app').children.length > 0);
}

// Waits until the screen shows text matching the pattern (after an action that reloads the screen).
export async function waitText(page, re, timeout = 8000) {
  await page.waitForFunction((src) => new RegExp(src[0], src[1]).test(document.querySelector('#app')?.innerText || ''), [re.source, re.flags], { timeout });
}
