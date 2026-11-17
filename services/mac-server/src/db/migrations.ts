export interface Migration {
  /** Monotonic, zero-padded id; never renumber or edit an applied migration. */
  id: string;
  name: string;
  sql: string;
}

/**
 * Append-only migration list. The runner refuses to start if an applied
 * migration's SQL no longer matches what was recorded (checksum mismatch) or
 * if the database knows a migration this build does not.
 */
export const migrations: readonly Migration[] = [
  {
    id: '0001',
    name: 'initial_schema',
    sql: /* sql */ `
      CREATE TABLE works (
        id                  TEXT PRIMARY KEY,
        title               TEXT NOT NULL,
        type                TEXT NOT NULL CHECK (type IN ('article','image','video','mixed')),
        status              TEXT NOT NULL CHECK (status IN ('drafting','in_review','ready','published')),
        tags                TEXT NOT NULL DEFAULT '[]',
        source              TEXT NOT NULL,
        storage_mode        TEXT NOT NULL CHECK (storage_mode IN ('managed','external')),
        -- Path of the .md file: relative to CREATORHUB_HOME for managed works,
        -- absolute for works in a mounted external folder.
        source_path         TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX works_updated_at ON works (updated_at DESC);
      CREATE INDEX works_status ON works (status);
      CREATE INDEX works_type ON works (type);

      CREATE TABLE revisions (
        revision_id        TEXT PRIMARY KEY,
        work_id            TEXT NOT NULL REFERENCES works (id) ON DELETE CASCADE,
        parent_revision_id TEXT REFERENCES revisions (revision_id),
        content_hash       TEXT NOT NULL,
        -- Snapshot file relative to CREATORHUB_HOME.
        snapshot_path      TEXT NOT NULL,
        title              TEXT NOT NULL,
        source             TEXT NOT NULL CHECK (source IN ('create','edit','external','restore','ai_accepted')),
        created_at         TEXT NOT NULL
      );
      CREATE INDEX revisions_work ON revisions (work_id, created_at);

      CREATE TABLE assets (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('image','video','audio','markdown','other')),
        path       TEXT NOT NULL,
        sha256     TEXT NOT NULL,
        mime_type  TEXT NOT NULL,
        bytes      INTEGER NOT NULL CHECK (bytes >= 0),
        duration   REAL,
        width      INTEGER,
        height     INTEGER,
        origin     TEXT NOT NULL CHECK (origin IN ('upload','url','folder','api','manual')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX assets_sha256 ON assets (sha256);

      CREATE TABLE work_assets (
        work_id  TEXT NOT NULL REFERENCES works (id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
        role     TEXT NOT NULL CHECK (role IN ('cover','body','video')),
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (work_id, asset_id, role)
      );

      CREATE TABLE platform_variants (
        id             TEXT PRIMARY KEY,
        work_id        TEXT NOT NULL REFERENCES works (id) ON DELETE CASCADE,
        platform       TEXT NOT NULL CHECK (platform IN ('xiaohongshu','wechat_mp','douyin','wechat_channels')),
        title          TEXT NOT NULL DEFAULT '',
        body           TEXT NOT NULL DEFAULT '',
        cover_asset_id TEXT REFERENCES assets (id) ON DELETE SET NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (work_id, platform)
      );

      CREATE TABLE import_jobs (
        id              TEXT PRIMARY KEY,
        method          TEXT NOT NULL CHECK (method IN ('markdown','upload','url','folder')),
        status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        progress        REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        retry_count     INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        idempotency_key TEXT UNIQUE,
        payload         TEXT,
        result_work_id  TEXT REFERENCES works (id) ON DELETE SET NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE ai_jobs (
        id              TEXT PRIMARY KEY,
        work_id         TEXT REFERENCES works (id) ON DELETE SET NULL,
        model           TEXT NOT NULL,
        action          TEXT NOT NULL,
        source_revision TEXT REFERENCES revisions (revision_id),
        status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        cache_key       TEXT,
        result          TEXT,
        usage           TEXT,
        cost_estimate   REAL,
        error           TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX ai_jobs_cache_key ON ai_jobs (cache_key);

      -- Full-text index over title, tags and body. The trigram tokenizer
      -- gives substring matching that works for Chinese text (3+ chars).
      CREATE VIRTUAL TABLE works_fts USING fts5 (
        work_id UNINDEXED,
        title,
        tags,
        body,
        tokenize = 'trigram'
      );
    `,
  },
  {
    id: '0002',
    name: 'assets_jobs_change_log',
    sql: /* sql */ `
      -- Asset fields needed by uploads, thumbnails and probing.
      ALTER TABLE assets ADD COLUMN original_name TEXT;
      ALTER TABLE assets ADD COLUMN codec TEXT;
      ALTER TABLE assets ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'none'
        CHECK (metadata_status IN ('none','pending','ready','unavailable','failed'));
      ALTER TABLE assets ADD COLUMN thumbnail_status TEXT NOT NULL DEFAULT 'none'
        CHECK (thumbnail_status IN ('none','pending','ready','failed'));
      ALTER TABLE assets ADD COLUMN updated_at TEXT;
      UPDATE assets SET updated_at = created_at WHERE updated_at IS NULL;
      CREATE INDEX assets_created_at ON assets (created_at DESC);

      -- Durable background work (thumbnails, probing). Survives restarts:
      -- rows left 'running' by a crash are re-queued on startup.
      CREATE TABLE background_jobs (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        subject_id   TEXT NOT NULL,
        payload      TEXT NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
        attempts     INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after    TEXT NOT NULL,
        last_error   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX background_jobs_ready ON background_jobs (status, run_after);
      CREATE INDEX background_jobs_subject ON background_jobs (kind, subject_id);

      -- Append-only change feed behind SSE (/api/v1/events) and future
      -- incremental sync; seq doubles as the SSE event id.
      CREATE TABLE change_log (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        entity     TEXT NOT NULL CHECK (entity IN ('work','asset','job')),
        entity_id  TEXT NOT NULL,
        action     TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '0003',
    name: 'url_imports_tokens_idempotency',
    sql: /* sql */ `
      -- URL import details. idempotency_key stores "<principal>:<key>" so keys
      -- from different tokens never collide.
      ALTER TABLE import_jobs ADD COLUMN url TEXT;
      ALTER TABLE import_jobs ADD COLUMN filename TEXT;
      ALTER TABLE import_jobs ADD COLUMN error_code TEXT;
      ALTER TABLE import_jobs ADD COLUMN result_asset_id TEXT REFERENCES assets (id) ON DELETE SET NULL;
      ALTER TABLE import_jobs ADD COLUMN link_work_id TEXT REFERENCES works (id) ON DELETE SET NULL;
      ALTER TABLE import_jobs ADD COLUMN link_role TEXT;
      ALTER TABLE import_jobs ADD COLUMN created_by TEXT;
      CREATE INDEX import_jobs_status ON import_jobs (status, created_at DESC);

      -- Revocable least-privilege tokens for external agents. Only a sha256
      -- of the secret is stored; prefix is shown in listings.
      CREATE TABLE api_tokens (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        prefix       TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        scopes       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      );

      -- Stored responses for Idempotency-Key replays.
      CREATE TABLE idempotency_records (
        principal     TEXT NOT NULL,
        endpoint      TEXT NOT NULL,
        key           TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        status_code   INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (principal, endpoint, key)
      );
    `,
  },
  {
    id: '0004',
    name: 'external_mounts',
    sql: /* sql */ `
      -- Mounted external folders: indexed in place, never moved or deleted.
      -- root_path is the realpath of the folder at mount time.
      CREATE TABLE mounts (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        root_path    TEXT NOT NULL UNIQUE,
        status       TEXT NOT NULL CHECK (status IN ('active','unavailable','removed')),
        last_scan_at TEXT,
        last_error   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      -- External works: source_path is relative to the mount root.
      -- external_state tracks the file on disk; the work row and its
      -- snapshots are kept whatever happens to the file.
      ALTER TABLE works ADD COLUMN mount_id TEXT REFERENCES mounts (id);
      ALTER TABLE works ADD COLUMN external_state TEXT
        CHECK (external_state IS NULL OR external_state IN ('present','missing','unmounted'));
      CREATE UNIQUE INDEX works_mount_path ON works (mount_id, source_path) WHERE mount_id IS NOT NULL;
    `,
  },
  {
    id: '0005',
    name: 'external_assets',
    sql: /* sql */ `
      -- Media referenced by external works, indexed in place (never moved or
      -- copied). For these rows path is relative to the mount root, and
      -- file_mtime_ms + bytes tell whether the file changed since it was hashed.
      ALTER TABLE assets ADD COLUMN mount_id TEXT REFERENCES mounts (id);
      ALTER TABLE assets ADD COLUMN file_mtime_ms REAL;
      CREATE UNIQUE INDEX assets_mount_path ON assets (mount_id, path) WHERE mount_id IS NOT NULL;
    `,
  },
  {
    id: '0006',
    name: 'platform_variant_revisions',
    sql: /* sql */ `
      -- Ordered images of a platform variant (JSON array of asset ids) and the
      -- work revision its latest draft was generated from.
      ALTER TABLE platform_variants ADD COLUMN image_asset_ids TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE platform_variants ADD COLUMN source_work_revision_id TEXT;

      -- Append-only history: one full copy of the variant per revision.
      -- Variants are small structured records derived from the original, so
      -- history lives in SQLite rather than as files next to source.md.
      CREATE TABLE platform_variant_revisions (
        variant_id      TEXT NOT NULL REFERENCES platform_variants (id) ON DELETE CASCADE,
        revision        INTEGER NOT NULL CHECK (revision >= 1),
        source          TEXT NOT NULL CHECK (source IN ('draft','edit')),
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        cover_asset_id  TEXT,
        image_asset_ids TEXT NOT NULL,
        tags            TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (variant_id, revision)
      );
    `,
  },
];
