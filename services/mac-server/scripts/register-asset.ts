/**
 * Dev helper (M0): copy a local media file into a managed work's assets folder
 * so the Range stream endpoint can be exercised before the M1 import center exists.
 *
 *   CREATORHUB_HOME=/tmp/ch pnpm --filter @qiu-creator/mac-server asset:register <work-id> <file>
 *
 * Opens the same SQLite database as the server (WAL allows concurrent use).
 */
import path from 'node:path';
import { AssetService } from '../src/assets/asset-service.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { Layout } from '../src/layout.js';

const [workId, file] = process.argv.slice(2);
if (workId === undefined || file === undefined) {
  process.stderr.write('usage: register-asset <work-id> <file>\n');
  process.exit(2);
}
if (process.env['CREATORHUB_HOME'] === undefined) {
  process.stderr.write('refusing to run without an explicit CREATORHUB_HOME\n');
  process.exit(2);
}
const config = loadConfig();
const layout = new Layout(config.home);
const db = openDatabase(layout.databaseFile);
try {
  const { id } = new AssetService(db, layout).registerFromFile(workId, path.resolve(file));
  process.stdout.write(`${id}\n`);
} finally {
  db.close();
}
