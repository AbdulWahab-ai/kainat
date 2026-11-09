// Deletes the local database and uploads so the next start re-seeds the demo data.
// Stop the server before running this.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) fs.rmSync(path.join(DATA, f), { force: true });
fs.rmSync(path.join(DATA, 'uploads'), { recursive: true, force: true });
console.log(`Reset ${DATA}. Start the server to re-seed demo data.`);
