// Starts a throwaway Kainat server on a free port with its own temporary database, plus an API client.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%test\n').toString('base64');

export const PHONES = {
  admin: '03000000000', alNoor: '03001111111', sunCity: '03002222222', greenVolt: '03003333333', bright: '03004444444',
  abbas: '03005555555', newEra: '03006666666', sunPeak: '03211111111', greenRoof: '03212222222', brightWorks: '03213333333',
};

// Quiet hours are off by default so tests behave the same at any time of day; notification tests turn them on.
// TEST_HOOKS adds /api/test/clock and /api/test/tick and stops the background job timer.
export async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kainat-test-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, TEST_HOOKS: '1', DEFAULT_QUIET: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + stderr)), 15000);
    proc.stdout.on('data', (d) => {
      const m = /:(\d+)\s*$/m.exec(String(d));
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on('exit', (code) => reject(new Error(`Server exited (${code}): ${stderr}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, dataDir, port,
    get stderr() { return stderr; },
    // Direct database access for setting up edge cases (expired codes, old requests).
    db() { return new DatabaseSync(path.join(dataDir, 'app.db')); },
    // Move the server clock forward, or run scheduled jobs now.
    async advance(minutes) { return (await fetch(`${base}/api/test/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ advance_minutes: minutes }) })).json(); },
    async setClock(iso) { return (await fetch(`${base}/api/test/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: iso }) })).json(); },
    async tick(jobs) { return (await fetch(`${base}/api/test/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs }) })).json(); },
    async stop() {
      // Windows keeps the database file locked until the process has really gone, so wait for the exit.
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await exited;
      }
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async raw(method, p, body, headers = {}) {
    return fetch(this.base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  async call(method, p, body) {
    const res = await this.raw(method, p, body);
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`${method} ${p} -> ${res.status} ${data.error}`);
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  }
  async login(phone) {
    const s = await this.call('POST', '/api/auth/start', { phone });
    await this.call('POST', '/api/auth/verify', { phone, code: s.devCode });
    return (await this.call('GET', '/api/me')).me;
  }
  me() { return this.call('GET', '/api/me'); }
}

// Asserts that a call fails with the given HTTP status (and optionally a message pattern).
export async function rejects(promise, status, re) {
  try {
    await promise;
  } catch (e) {
    if (e.status !== status) throw new Error(`Expected ${status}, got ${e.status}: ${e.message}`);
    if (re && !re.test(e.body?.error || '')) throw new Error(`Error "${e.body?.error}" does not match ${re}`);
    return e;
  }
  throw new Error(`Expected a ${status} error, but the call succeeded`);
}

export async function as(base, who) {
  const c = new Client(base);
  await c.login(PHONES[who] || who);
  return c;
}
