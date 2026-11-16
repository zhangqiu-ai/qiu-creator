import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CreateMountRequestSchema,
  MOUNT_MAX_MARKDOWN_BYTES,
  MountSchema,
  type CreateMountRequest,
  type Mount,
} from '@qiu-creator/contracts';
import { isPathInside } from '@qiu-creator/domain';
import { watch, type FSWatcher } from 'chokidar';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { JobQueue, JobRecord } from '../jobs/job-queue.js';
import type { Layout } from '../layout.js';
import type { WorkService } from '../works/work-service.js';

interface MountRow {
  id: string;
  name: string;
  root_path: string;
  status: string;
  last_scan_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  work_count: number;
}

export interface MountServiceOptions {
  /** Start file watchers (tests that only scan can turn this off). */
  watch?: boolean;
  /** How long a file must stop changing before it is indexed (default 2000 ms). */
  stabilityMs?: number;
  /** Poll interval while waiting for writes to finish (default 200 ms). */
  writePollMs?: number;
  /**
   * File-event source. Default `auto` (FSEvents on macOS). FSEvents can be
   * seconds late or coalesce events under heavy I/O, so tests use `polling`
   * for determinism; the periodic rescan below covers anything missed.
   */
  backend?: 'auto' | 'native' | 'polling';
  /** Poll interval for the `polling` backend (default 1000 ms). */
  pollIntervalMs?: number;
  /** Safety-net full rescan of every active mount (default 10 min; 0 disables). */
  rescanIntervalMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

const MARKDOWN_RE = /\.(md|markdown)$/i;
const SKIPPED_DIRS = new Set(['node_modules']);

/** Hidden entries (dotfiles, editor and atomic-write temp files like `.x.md.ab12.tmp`) and non-Markdown files are ignored. */
export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('~') || SKIPPED_DIRS.has(name);
}

/**
 * Mounted external folders. Files are indexed in place: this service never
 * moves, renames or deletes anything inside a mount. Symlinks are not
 * followed, so a mount cannot reach outside its own folder.
 */
export class MountService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly readyPromises = new Map<string, Promise<void>>();
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly opts: Required<Omit<MountServiceOptions, 'log'>> &
    Pick<MountServiceOptions, 'log'>;

  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly works: WorkService,
    private readonly jobs: JobQueue,
    options: MountServiceOptions = {},
  ) {
    this.opts = {
      watch: options.watch ?? true,
      stabilityMs: options.stabilityMs ?? 2000,
      writePollMs: options.writePollMs ?? 200,
      backend: options.backend ?? 'auto',
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      rescanIntervalMs: options.rescanIntervalMs ?? 10 * 60 * 1000,
      log: options.log,
    };
    jobs.register('mount.scan', (job) => this.runScan(job));
  }

  /** Resume watchers and queue a catch-up scan for every mount after a restart. */
  start(): void {
    for (const m of this.rows()) {
      if (m.status === 'removed') continue;
      this.startWatcher(m);
      this.jobs.enqueue('mount.scan', m.id);
    }
    if (this.opts.rescanIntervalMs > 0) {
      this.rescanTimer = setInterval(() => {
        for (const m of this.rows()) {
          if (m.status !== 'removed') this.jobs.enqueue('mount.scan', m.id);
        }
      }, this.opts.rescanIntervalMs);
      this.rescanTimer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    const all = [...this.watchers.values()];
    this.watchers.clear();
    this.readyPromises.clear();
    await Promise.all(all.map((w) => w.close()));
  }

  list(): Mount[] {
    return this.rows().map(toMount);
  }

  get(id: string): Mount {
    const row = this.rows(id)[0];
    if (!row) throw notFound('mount');
    return toMount(row);
  }

  /**
   * Mount a folder. Rejects relative paths, non-directories, `/`, the user's
   * home folder itself, anything overlapping CREATORHUB_HOME (in either
   * direction) and anything overlapping another mount. Re-mounting a removed
   * folder reactivates it so its works and history reconnect.
   */
  create(input: CreateMountRequest): Mount {
    const req = CreateMountRequestSchema.parse(input);
    const root = this.validateRoot(req.path);
    const now = new Date().toISOString();
    const previous = this.db
      .prepare<[string], { id: string; status: string }>(
        'SELECT id, status FROM mounts WHERE root_path = ?',
      )
      .get(root);
    let id: string;
    if (previous) {
      if (previous.status !== 'removed') {
        throw new ServiceError(409, 'mount_rejected', 'this folder is already mounted', {
          mount_id: previous.id,
        });
      }
      id = previous.id;
      this.db
        .prepare(
          "UPDATE mounts SET status = 'active', name = coalesce(?, name), last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(req.name ?? null, now, id);
    } else {
      id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO mounts (id, name, root_path, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .run(id, req.name ?? path.basename(root), root, now, now);
    }
    const row = this.requireRow(id);
    this.startWatcher(row);
    this.jobs.enqueue('mount.scan', id);
    return toMount(row);
  }

  /** Unmount: stop watching and mark its works `unmounted`. Files on disk and history are untouched. */
  async remove(id: string): Promise<Mount> {
    const row = this.requireRow(id);
    await this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.readyPromises.delete(id);
    this.db
      .prepare("UPDATE mounts SET status = 'removed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    this.works.setMountState(id, 'unmounted');
    return this.get(id);
  }

  rescan(id: string): Mount {
    const row = this.requireRow(id);
    if (row.status === 'removed') {
      throw new ServiceError(
        409,
        'mount_rejected',
        'this mount was removed; mount the folder again',
      );
    }
    this.jobs.enqueue('mount.scan', id);
    return toMount(row);
  }

  // ---- validation -------------------------------------------------------------

  private validateRoot(raw: string): string {
    if (!path.isAbsolute(raw) || raw.includes('\0')) {
      throw new ServiceError(400, 'mount_rejected', 'path must be an absolute folder path');
    }
    let root: string;
    try {
      root = fs.realpathSync(path.resolve(raw));
      if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
      fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      throw new ServiceError(400, 'mount_rejected', 'path is not a readable folder');
    }
    if (root === path.parse(root).root) {
      throw new ServiceError(400, 'mount_rejected', 'the filesystem root cannot be mounted');
    }
    const userHome = safeRealpath(os.homedir());
    if (userHome !== null && root === userHome) {
      throw new ServiceError(
        400,
        'mount_rejected',
        'mount a specific folder, not the whole home folder',
      );
    }
    const home = safeRealpath(this.layout.home) ?? path.resolve(this.layout.home);
    if (isPathInside(home, root) || isPathInside(root, home)) {
      throw new ServiceError(
        400,
        'mount_rejected',
        'folders inside or containing the CreatorHub data folder cannot be mounted',
      );
    }
    for (const other of this.rows()) {
      if (other.status === 'removed' || other.root_path === root) continue;
      if (isPathInside(other.root_path, root) || isPathInside(root, other.root_path)) {
        throw new ServiceError(
          400,
          'mount_rejected',
          `overlaps the existing mount "${other.name}"`,
          {
            mount_id: other.id,
          },
        );
      }
    }
    return root;
  }

  // ---- scanning ---------------------------------------------------------------

  private async runScan(job: JobRecord): Promise<void> {
    const row = this.rows(job.subject_id)[0];
    if (!row || row.status === 'removed') return;
    const now = (): string => new Date().toISOString();
    let files: string[];
    try {
      files = await listMarkdown(row.root_path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db
        .prepare(
          "UPDATE mounts SET status = 'unavailable', last_error = ?, updated_at = ? WHERE id = ?",
        )
        .run(message, now(), row.id);
      this.works.setMountState(row.id, 'missing');
      return;
    }
    if (row.status === 'unavailable') {
      this.db
        .prepare(
          "UPDATE mounts SET status = 'active', last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now(), row.id);
      this.startWatcher(this.requireRow(row.id));
    }
    const seen = new Set<string>();
    const label = `mount:${row.name}`;
    for (const [i, rel] of files.entries()) {
      seen.add(rel);
      this.works.syncExternalFile(row.id, rel, label);
      if (i % 50 === 49) await new Promise((r) => setImmediate(r)); // keep the server responsive
    }
    for (const rel of this.works.externalPaths(row.id)) {
      if (!seen.has(rel)) this.works.checkExternalPath(row.id, rel);
    }
    this.db
      .prepare('UPDATE mounts SET last_scan_at = ?, updated_at = ? WHERE id = ?')
      .run(now(), now(), row.id);
  }

  // ---- watching ---------------------------------------------------------------

  private startWatcher(row: MountRow): void {
    if (!this.opts.watch || this.watchers.has(row.id) || row.status !== 'active') return;
    const root = row.root_path;
    const watcher = watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      persistent: true,
      atomic: true,
      backend: this.opts.backend,
      interval: this.opts.pollIntervalMs,
      // Wait until a file stops growing before indexing it, so half-written files never enter the library.
      awaitWriteFinish: {
        stabilityThreshold: this.opts.stabilityMs,
        pollInterval: this.opts.writePollMs,
      },
      ignored: (p: string, stats?: fs.Stats) => {
        const rel = path.relative(root, p);
        if (rel === '') return false;
        if (rel.split(path.sep).some(isIgnoredName)) return true;
        return stats?.isFile() === true && !MARKDOWN_RE.test(p);
      },
    });
    this.readyPromises.set(
      row.id,
      new Promise((resolve) => {
        watcher.once('ready', () => {
          resolve();
        });
      }),
    );
    const label = `mount:${row.name}`;
    const relOf = (p: string): string | null => {
      const rel = path.relative(root, p);
      return rel === '' || rel.startsWith('..') || !MARKDOWN_RE.test(rel) ? null : rel;
    };
    const guard = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        this.opts.log?.(`mount ${row.id}: ${what} failed`, err);
      }
    };
    watcher.on('add', (p: string, stats?: fs.Stats) => {
      const rel = relOf(p);
      if (rel === null || (stats !== undefined && stats.size > MOUNT_MAX_MARKDOWN_BYTES)) return;
      guard(`add ${rel}`, () => this.works.syncExternalFile(row.id, rel, label));
    });
    watcher.on('change', (p: string, stats?: fs.Stats) => {
      const rel = relOf(p);
      if (rel === null || (stats !== undefined && stats.size > MOUNT_MAX_MARKDOWN_BYTES)) return;
      guard(`change ${rel}`, () => this.works.syncExternalFile(row.id, rel, label));
    });
    watcher.on('unlink', (p: string) => {
      const rel = relOf(p);
      if (rel !== null)
        guard(`unlink ${rel}`, () => {
          this.works.checkExternalPath(row.id, rel);
        });
    });
    watcher.on('error', (err: unknown) => this.opts.log?.(`mount ${row.id}: watcher error`, err));
    this.watchers.set(row.id, watcher);
  }

  /** Resolves once the watcher for `id` has finished its initial crawl (tests, evidence). */
  ready(id: string): Promise<void> {
    return this.readyPromises.get(id) ?? Promise.resolve();
  }

  // ---- rows -------------------------------------------------------------------

  private rows(id?: string): MountRow[] {
    const sql = `SELECT m.*, (SELECT count(*) FROM works w WHERE w.mount_id = m.id) AS work_count
                 FROM mounts m ${id === undefined ? '' : 'WHERE m.id = ?'} ORDER BY m.created_at`;
    return id === undefined
      ? this.db.prepare<[], MountRow>(sql).all()
      : this.db.prepare<[string], MountRow>(sql).all(id);
  }

  private requireRow(id: string): MountRow {
    const row = this.rows(id)[0];
    if (!row) throw notFound('mount');
    return row;
  }
}

function toMount(row: MountRow): Mount {
  return MountSchema.parse(row);
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Markdown files under `root`, relative paths, sorted. Hidden entries,
 * `node_modules`, symlinks and files over the size limit are skipped.
 * Throws if the root itself cannot be read.
 */
export async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  await fs.promises.access(root, fs.constants.R_OK);
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subfolder: skip it, keep the rest
    }
    for (const entry of entries) {
      if (isIgnoredName(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && MARKDOWN_RE.test(entry.name)) {
        const size = (await fs.promises.stat(full)).size;
        if (size <= MOUNT_MAX_MARKDOWN_BYTES) out.push(path.relative(root, full));
      }
    }
  };
  await walk(root);
  return out.sort();
}
