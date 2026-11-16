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
];
