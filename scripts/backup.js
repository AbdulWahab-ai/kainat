// Backs up the live database and uploaded files, checks the copy, and keeps the newest copies only.
// Safe while the server is running: SQLite's VACUUM INTO writes a consistent snapshot.
//
//   node scripts/backup.js                  back up to the default folders
//   BACKUP_DIRS="E:\a;F:\b" node scripts/backup.js
//
// Default folders: D:\Backups\kainat (keeps 30) and, when OneDrive is set up, OneDrive\Backups\kainat (keeps 14),
// so one copy also leaves this PC.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const UPLOADS = path.join(DATA_DIR, 'uploads');

const targets = process.env.BACKUP_DIRS
  ? process.env.BACKUP_DIRS.split(';').filter(Boolean).map((dir) => ({ dir, keep: 30 }))
  : [
      { dir: 'D:\\Backups\\kainat', keep: 30 },
      ...(process.env.OneDrive ? [{ dir: path.join(process.env.OneDrive, 'Backups', 'kainat'), keep: 14 }] : []),
    ];

if (!fs.existsSync(DB_FILE)) {
  console.error(`No database at ${DB_FILE}. Nothing to back up.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13); // 20261109-1530
const name = `kainat-${stamp}`;

// One snapshot, then copied to each target, so every copy is identical.
const tmp = path.join(DATA_DIR, `.backup-${process.pid}.db`);
fs.rmSync(tmp, { force: true });
const live = new DatabaseSync(DB_FILE);
live.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
live.close();

const check = new DatabaseSync(tmp, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
const counts = check.prepare(`SELECT (SELECT COUNT(*) FROM businesses) businesses, (SELECT COUNT(*) FROM orders) orders,
  (SELECT COUNT(*) FROM chat_messages) messages`).get();
check.close();
if (Object.values(ok)[0] !== 'ok') {
  fs.rmSync(tmp, { force: true });
  console.error('Backup failed its integrity check. The live database was not changed.');
  process.exit(1);
}

let failed = 0;
for (const { dir, keep } of targets) {
  try {
    const dest = path.join(dir, name);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(tmp, path.join(dest, 'app.db'));
    if (fs.existsSync(UPLOADS)) fs.cpSync(UPLOADS, path.join(dest, 'uploads'), { recursive: true });
    const old = fs.readdirSync(dir).filter((d) => /^kainat-\d{8}-\d{4}$/.test(d)).sort().reverse().slice(keep);
    for (const d of old) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    console.log(`Backed up to ${dest}`);
  } catch (e) {
    failed++;
    console.error(`Could not back up to ${dir}: ${e.message}`);
  }
}
fs.rmSync(tmp, { force: true });
console.log(`Contains ${counts.businesses} businesses, ${counts.orders} orders, ${counts.messages} chat messages.`);
process.exit(failed === targets.length ? 1 : 0);
