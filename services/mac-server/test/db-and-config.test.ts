import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, tokenFilePath } from '../src/config.js';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations } from '../src/db/migrations.js';
import { makeTempHome } from './helpers.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function home(): string {
  const h = makeTempHome();
  homes.push(h);
  return h;
}

describe('database', () => {
  it('opens in WAL mode and creates every plan-section-3 table plus FTS', () => {
    const db = openDatabase(path.join(home(), 'data', 'db.sqlite'));
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      for (const t of [
        'works',
        'assets',
        'work_assets',
        'platform_variants',
        'revisions',
        'import_jobs',
        'ai_jobs',
        'works_fts',
        'schema_migrations',
      ]) {
        expect(tables).toContain(t);
      }
    } finally {
      db.close();
    }
  });

  it('adds asset metadata and trash columns without touching existing assets (0013)', () => {
    const file = path.join(home(), 'db.sqlite');
    const db = openDatabase(
      file,
      migrations.filter((migration) => migration.id <= '0012'),
    );
    try {
      db.prepare(
        `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, origin, created_at, original_name, updated_at)
         VALUES ('a1', 'image', 'library/assets/a1/x.png', ?, 'image/png', 3, 'upload', 't', 'x.png', 't')`,
      ).run('b'.repeat(64));
      const before = db.prepare("SELECT * FROM assets WHERE id = 'a1'").get();
      expect(runMigrations(db, migrations)).toEqual(['0013']);
      expect(db.prepare("SELECT * FROM assets WHERE id = 'a1'").get()).toEqual({
        ...(before as Record<string, unknown>),
        display_name: null,
        tags: '[]',
        alt_text: null,
        note: null,
        revision: 1,
        deleted_at: null,
        removal: null,
      });
      expect(() => db.prepare("UPDATE assets SET removal = 'gone' WHERE id = 'a1'").run()).toThrow(
        /CHECK/,
      );
    } finally {
      db.close();
    }
  });

  it('keeps saved provider settings when adding New API', () => {
    const file = path.join(home(), 'db.sqlite');
    const db = openDatabase(
      file,
      migrations.filter((migration) => migration.id < '0012'),
    );
    try {
      const timestamp = '2026-11-19T00:00:00.000Z';
      db.prepare('INSERT INTO ai_providers VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'openai',
        timestamp,
        'gpt-5.5',
        null,
        1,
        timestamp,
        timestamp,
      );
      const before = db.prepare('SELECT * FROM ai_providers').get();
      expect(
        runMigrations(
          db,
          migrations.filter((m) => m.id <= '0012'),
        ),
      ).toEqual(['0012']);
      expect(db.prepare('SELECT * FROM ai_providers').get()).toMatchObject({
        ...(before as Record<string, unknown>),
        credential_id: null,
      });
    } finally {
      db.close();
    }
  });

  it('is idempotent and refuses edited or unknown applied migrations', () => {
    const file = path.join(home(), 'db.sqlite');
    const db = openDatabase(file);
    try {
      expect(runMigrations(db, migrations)).toEqual([]);
      const edited = migrations.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }));
      expect(() => runMigrations(db, edited)).toThrow(/modified after being applied/);
      expect(() => runMigrations(db, [])).toThrow(/unknown to this build/);
    } finally {
      db.close();
    }
  });
});

describe('config', () => {
  it('defaults to 127.0.0.1:7420 and creates a private token file once', () => {
    const h = home();
    const first = loadConfig({ CREATORHUB_HOME: h });
    expect(first).toMatchObject({ home: h, host: '127.0.0.1', port: 7420, tokenSource: 'file' });
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(tokenFilePath(h)).mode & 0o777).toBe(0o600);
    expect(loadConfig({ CREATORHUB_HOME: h }).token).toBe(first.token);
  });

  it('uses CREATORHUB_TOKEN when set and rejects weak tokens', () => {
    const h = home();
    expect(loadConfig({ CREATORHUB_HOME: h, CREATORHUB_TOKEN: 'a'.repeat(20) }).tokenSource).toBe(
      'env',
    );
    expect(() => loadConfig({ CREATORHUB_HOME: h, CREATORHUB_TOKEN: 'short' })).toThrow(
      /at least 16/,
    );
    expect(() => loadConfig({ CREATORHUB_HOME: h, CREATORHUB_PORT: 'abc' })).toThrow(
      /CREATORHUB_PORT/,
    );
  });
});
