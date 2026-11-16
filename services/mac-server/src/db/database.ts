import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '@qiu-creator/domain';
import Database from 'better-sqlite3';
import { migrations as defaultMigrations, type Migration } from './migrations.js';

export type Db = Database.Database;

export function openDatabase(
  file: string,
  migrations: readonly Migration[] = defaultMigrations,
): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  runMigrations(db, migrations);
  return db;
}

interface AppliedRow {
  id: string;
  checksum: string;
}

/** Apply pending migrations in order. Append-only: edited or unknown applied migrations abort startup. */
export function runMigrations(db: Db, migrations: readonly Migration[]): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const ids = migrations.map((m) => m.id);
  const sorted = [...ids].sort();
  if (ids.some((id, i) => id !== sorted[i]) || new Set(ids).size !== ids.length) {
    throw new Error('migrations must have unique ids in ascending order');
  }

  const applied = new Map(
    db
      .prepare<[], AppliedRow>('SELECT id, checksum FROM schema_migrations')
      .all()
      .map((r) => [r.id, r.checksum]),
  );
  for (const id of applied.keys()) {
    if (!ids.includes(id)) {
      throw new Error(`database has migration ${id} unknown to this build; refusing to start`);
    }
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    const checksum = sha256Hex(migration.sql);
    const recorded = applied.get(migration.id);
    if (recorded !== undefined) {
      if (recorded !== checksum) {
        throw new Error(
          `migration ${migration.id} (${migration.name}) was modified after being applied; add a new migration instead`,
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id, migration.name, checksum, new Date().toISOString());
    })();
    newlyApplied.push(migration.id);
  }
  return newlyApplied;
}
