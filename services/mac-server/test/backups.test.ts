import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import { type ChangeEvent } from '@qiu-creator/contracts';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/ai/secret-store.js';
import { BackupService } from '../src/backups/backup-service.js';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations } from '../src/db/migrations.js';
import { ChangeFeed } from '../src/events/change-feed.js';
import { startHost, type ServerHost } from '../src/host.js';
import { Layout } from '../src/layout.js';
import { noWakeLocks } from '../src/power/sleep-guard.js';
import {
  authHeaders,
  makeTempHome,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from './helpers.js';

const homes: string[] = [];
const hosts: ServerHost[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const s of servers.splice(0)) await s.close();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const h = makeTempHome();
  homes.push(h);
  return h;
}

async function host(dir: string = home()) {
  const fatal: unknown[] = [];
  const h = await startHost(
    {
      config: { home: dir, token: TEST_TOKEN },
      ffprobe: null,
      backups: { schedule: false },
      sleep: { provider: noWakeLocks },
      ai: { secrets: new MemorySecretStore(), start: false },
    },
    { host: '127.0.0.1', port: 0 },
    (err) => fatal.push(err),
  );
  hosts.push(h);
  return { h, dir, fatal, client: createClient({ baseUrl: h.address, token: TEST_TOKEN }) };
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe('SQLite backups (QC-030)', () => {
  it('backs up online, checks integrity, lists newest first, files private', async () => {
    const { h, dir, client } = await host();
    await client.works.create({ title: '第一篇', markdown: '# 一\n' });
    const a = await client.backups.create();
    expect(a).toMatchObject({ kind: 'manual', integrity: 'ok', schema_version: '0018' });
    expect(a.size_bytes).toBeGreaterThan(0);
    const b = await client.backups.create();
    const list = await client.backups.list();
    expect(list.backups.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list).toMatchObject({
      retention_per_kind: 14,
      directory: path.join(dir, 'backups'),
      last_daily_at: null,
      last_error: null,
    });
    expect(mode(path.join(dir, 'backups'))).toBe(0o700);
    expect(mode(path.join(dir, 'backups', `${a.id}.sqlite`))).toBe(0o600);
    // The copy is a complete, readable database with the work in it.
    const copy = new Database(path.join(dir, 'backups', `${a.id}.sqlite`), { readonly: true });
    expect(copy.prepare('SELECT title FROM works').all()).toEqual([{ title: '第一篇' }]);
    copy.close();
    const events = h
      .current()
      .feed.since(0)
      .filter((e) => e.action === 'backup.created');
    expect(events.map((e) => [e.entity, e.entity_id, e.data['backup_id']])).toEqual([
      ['system', 'database', a.id],
      ['system', 'database', b.id],
    ]);
  });

  it('is owner-only: agent tokens get 403 on every backup route', async () => {
    const { h, client } = await host();
    const backup = await client.backups.create();
    const agent = h.current().tokens.create({ name: 'a', scopes: ['read', 'import', 'write'] });
    const asAgent = createClient({ baseUrl: h.address, token: agent.secret });
    expect((await apiError(asAgent.backups.list())).status).toBe(403);
    expect((await apiError(asAgent.backups.create())).status).toBe(403);
    expect((await apiError(asAgent.backups.restore(backup.id))).status).toBe(403);
    const noAuth = await fetch(`${h.address}/api/v1/backups`);
    expect(noAuth.status).toBe(401);
  });

  it('takes the daily backup once a day and keeps 14 per kind', async () => {
    const dir = home();
    const layout = new Layout(dir);
    layout.ensureBase();
    const db = openDatabase(layout.databaseFile);
    const feed = new ChangeFeed(db);
    let now = new Date('2026-11-18T03:00:00.000Z');
    const svc = new BackupService(db, layout, feed, { now: () => now, schedule: false });
    try {
      const first = await svc.runDaily();
      expect(first?.kind).toBe('daily');
      now = new Date(now.getTime() + 23 * 3600_000);
      expect(await svc.runDaily()).toBeNull();
      expect(svc.list().next_daily_at).toBe('2026-11-19T03:00:00.000Z');
      for (let i = 0; i < 16; i++) {
        now = new Date(now.getTime() + 25 * 3600_000);
        expect(await svc.runDaily()).not.toBeNull();
      }
      for (let i = 0; i < 3; i++) await svc.create('manual');
      const list = svc.list();
      expect(list.backups.filter((b) => b.kind === 'daily')).toHaveLength(14);
      expect(list.backups.filter((b) => b.kind === 'manual')).toHaveLength(3);
      expect(list.last_daily_at).toBe(now.toISOString());
      // Pruned backups are gone from disk too (two files per backup).
      expect(fs.readdirSync(svc.dir)).toHaveLength(17 * 2);
    } finally {
      await svc.stop();
      db.close();
    }
  });

  it('restores in place: safety backup first, service reloads, SSE ids keep increasing', async () => {
    const { h, dir, client, fatal } = await host();
    const kept = await client.works.create({ title: '備份前', markdown: '# 舊\n' });
    const backup = await client.backups.create();
    const later = await client.works.create({ title: '備份後', markdown: '# 新\n' });
    const seqBefore = h.current().feed.latestSeq();
    const firstServer = h.current();

    const res = await client.backups.restore(backup.id);
    expect(res).toMatchObject({
      restored_from: { id: backup.id },
      safety_backup: { kind: 'pre_restore', integrity: 'ok' },
      reload: 'in_process',
    });
    await h.settled();
    expect(fatal).toEqual([]);
    expect(h.current()).not.toBe(firstServer);
    expect(fs.existsSync(path.join(dir, 'data', 'restore-pending.json'))).toBe(false);

    const titles = (await client.works.list()).items.map((w) => w.id);
    expect(titles).toContain(kept.id);
    expect(titles).not.toContain(later.id);
    expect((await client.health()).status).toBe('ok');

    // The restored change log continues after everything clients saw before.
    const after = h.current().feed.since(seqBefore);
    const restored = after.find((e: ChangeEvent) => e.action === 'backup.restored');
    expect(restored).toMatchObject({
      entity: 'system',
      data: { backup_id: backup.id, safety_backup_id: res.safety_backup.id },
    });
    expect(restored?.seq).toBeGreaterThan(seqBefore + 1);

    // Undo: the safety backup brings the later work back.
    await client.backups.restore(res.safety_backup.id);
    await h.settled();
    expect((await client.works.list()).items.map((w) => w.id)).toContain(later.id);
    const kinds = (await client.backups.list()).backups.map((b) => b.kind);
    expect(kinds.filter((k) => k === 'pre_restore')).toHaveLength(2);
  });

  it('without a host that can reload: writes get 503 and the restore applies on the next start', async () => {
    const dir = home();
    const s = await startTestServer({ home: dir });
    servers.push(s);
    const kept = await s.client.works.create({ title: '留下', markdown: '' });
    const backup = await s.client.backups.create();
    await s.client.works.create({ title: '會消失', markdown: '' });
    expect((await s.client.backups.restore(backup.id)).reload).toBe('restart_required');
    const write = await apiError(s.client.works.create({ title: '還原中', markdown: '' }));
    expect(write.status).toBe(503);
    expect(write.body?.error.code).toBe('restoring');
    expect((await apiError(s.client.backups.create())).status).toBe(503);
    expect((await s.client.works.list()).items).toHaveLength(2); // reads still work

    servers.splice(servers.indexOf(s), 1);
    await s.close();
    const s2 = await startTestServer({ home: dir });
    servers.push(s2);
    expect((await s2.client.works.list()).items.map((w) => w.id)).toEqual([kept.id]);
    expect(s2.feed.since(0).at(-1)?.action).toBe('backup.restored');
  });

  it('refuses a damaged backup or one from a newer version, and changes nothing', async () => {
    const { dir, client } = await host();
    await client.works.create({ title: '現況', markdown: '' });
    const damaged = await client.backups.create();
    const newer = await client.backups.create();
    const file = (id: string) => path.join(dir, 'backups', `${id}.sqlite`);
    const fd = fs.openSync(file(damaged.id), 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096);
    fs.closeSync(fd);
    const db = new Database(file(newer.id));
    db.prepare(
      "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES ('9999', 'future', 'x', 'now')",
    ).run();
    db.close();

    for (const id of [damaged.id, newer.id]) {
      const err = await apiError(client.backups.restore(id));
      expect(err.status).toBe(409);
      expect(err.body?.error.code).toBe('backup_not_restorable');
    }
    const missing = await apiError(client.backups.restore('20261118T030000000Z-manual'));
    expect(missing.status).toBe(404);
    const list = await client.backups.list();
    expect(list.backups.filter((b) => b.kind === 'pre_restore')).toHaveLength(0);
    expect((await client.works.list()).items).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'data', 'restore-pending.json'))).toBe(false);
    const bad = await fetch(`${hosts[0]?.address ?? ''}/api/v1/backups/..%2Fdata/restore`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    });
    expect(bad.status).toBe(400);
  });

  it('refuses with 409 backup_failed when the current state cannot be backed up, changing nothing', async () => {
    const { dir, client } = await host();
    const kept = await client.works.create({ title: '現況', markdown: '' });
    const backup = await client.backups.create();
    await client.works.create({ title: '之後', markdown: '' });
    const backupsDir = path.join(dir, 'backups');
    fs.chmodSync(backupsDir, 0o500); // the safety copy cannot be written
    try {
      const err = await apiError(client.backups.restore(backup.id));
      expect(err.status).toBe(409);
      expect(err.body?.error.code).toBe('backup_failed');
      // QC-043: a reason for the interface sentence, the raw text as technical detail.
      expect(err.body?.error.details).toMatchObject({ reason: 'permission_denied' });
      expect(typeof err.body?.error.details?.['detail']).toBe('string');
    } finally {
      fs.chmodSync(backupsDir, 0o700);
    }
    expect((await client.works.list()).items.map((w) => w.id)).toContain(kept.id);
    expect((await client.works.list()).items).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'data', 'restore-pending.json'))).toBe(false);
    // Not stuck in "restoring": writes still work.
    await client.works.create({ title: '還能寫', markdown: '' });
  });

  it('a pending restore whose backup became unreadable is cancelled at start', async () => {
    const { h, dir, client } = await host();
    const kept = await client.works.create({ title: '現況', markdown: '' });
    const backup = await client.backups.create();
    fs.writeFileSync(
      path.join(dir, 'data', 'restore-pending.json'),
      JSON.stringify({ backup_id: backup.id, safety_backup_id: backup.id, previous_seq: 1 }),
    );
    fs.writeFileSync(path.join(dir, 'backups', `${backup.id}.sqlite`), 'not a database');
    await h.close();
    hosts.splice(0);
    const again = await host(dir);
    expect((await again.client.works.list()).items.map((w) => w.id)).toEqual([kept.id]);
    expect(fs.existsSync(path.join(dir, 'data', 'restore-pending.json'))).toBe(false);
  });

  it('migration 0011 keeps change-log sequence numbers when it rebuilds the table', () => {
    const dir = home();
    const db = new Database(path.join(dir, 'x.sqlite'));
    runMigrations(
      db,
      migrations.filter((m) => m.id < '0011'),
    );
    const insert = db.prepare(
      "INSERT INTO change_log (entity, entity_id, action, data, created_at) VALUES ('work', 'w', 'work.created', '{}', 'now')",
    );
    for (let i = 0; i < 5; i++) insert.run();
    db.prepare('DELETE FROM change_log WHERE seq >= 4').run();
    runMigrations(db, migrations);
    insert.run();
    expect(db.prepare('SELECT max(seq) AS seq FROM change_log').get()).toEqual({ seq: 6 });
    db.prepare(
      "INSERT INTO change_log (entity, entity_id, action, data, created_at) VALUES ('system', 'database', 'backup.created', '{}', 'now')",
    ).run();
    db.close();
  });
});
