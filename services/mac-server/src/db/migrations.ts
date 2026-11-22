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
  {
    id: '0007',
    name: 'platform_variant_tombstones',
    sql: /* sql */ `
      -- Deleting a variant leaves a tombstone row (content cleared, history
      -- kept) that takes the next revision, so a work+platform revision never
      -- goes back and stale clients get 409 after a delete and recreate.
      ALTER TABLE platform_variants ADD COLUMN deleted_at TEXT;
    `,
  },
  {
    id: '0008',
    name: 'ai_foundation',
    sql: /* sql */ `
      -- AI jobs (table from 0001): provider, the request to replay on retry,
      -- classified failures, attempts with backoff, timing and the local
      -- month the usage is counted in. cost_estimate holds the post-run cost
      -- estimate; estimate_max_usd the pre-run upper bound.
      ALTER TABLE ai_jobs ADD COLUMN provider TEXT;
      ALTER TABLE ai_jobs ADD COLUMN input TEXT;
      ALTER TABLE ai_jobs ADD COLUMN error_code TEXT;
      ALTER TABLE ai_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ai_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE ai_jobs ADD COLUMN run_after TEXT;
      ALTER TABLE ai_jobs ADD COLUMN started_at TEXT;
      ALTER TABLE ai_jobs ADD COLUMN finished_at TEXT;
      ALTER TABLE ai_jobs ADD COLUMN usage_month TEXT;
      ALTER TABLE ai_jobs ADD COLUMN estimate TEXT;
      CREATE INDEX ai_jobs_queue ON ai_jobs (status, run_after);
      CREATE INDEX ai_jobs_usage_month ON ai_jobs (usage_month);

      -- Per-provider settings. Keys are NOT here: they live in the Keychain;
      -- key_set_at only records that one was stored.
      CREATE TABLE ai_providers (
        provider        TEXT PRIMARY KEY CHECK (provider IN ('gemini','anthropic','openai')),
        key_set_at      TEXT,
        text_model      TEXT,
        video_model     TEXT,
        consent_version INTEGER,
        consent_at      TEXT,
        updated_at      TEXT NOT NULL
      );

      -- Small JSON settings (AI budget, price overrides).
      CREATE TABLE app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '0009',
    name: 'text_ai_tasks',
    sql: /* sql */ `
      -- What a text AI job was for (platform suggestions or a rewrite, as
      -- JSON), and the revision created when its rewrite was accepted.
      ALTER TABLE ai_jobs ADD COLUMN task TEXT;
      ALTER TABLE ai_jobs ADD COLUMN accepted_revision_id TEXT;
      ALTER TABLE ai_jobs ADD COLUMN accepted_at TEXT;

      -- ai_accepted revisions point at the job whose candidate was accepted.
      ALTER TABLE revisions ADD COLUMN ai_job_id TEXT;
    `,
  },
  {
    id: '0010',
    name: 'ai_video_jobs',
    sql: /* sql */ `
      -- Public progress of multi-step AI jobs (phase, bytes uploaded), and
      -- private resume state (resumable upload URL and offset, remote file
      -- name) so a retry continues instead of starting over. The cache_key
      -- column from 0001 holds the video analysis cache key.
      ALTER TABLE ai_jobs ADD COLUMN progress TEXT;
      ALTER TABLE ai_jobs ADD COLUMN remote_state TEXT;
    `,
  },
  {
    id: '0011',
    name: 'change_log_system_entity',
    sql: /* sql */ `
      -- Service-wide events (backups, QC-030) use entity 'system'. SQLite cannot
      -- change a CHECK constraint, so the table is rebuilt; seq values and the
      -- AUTOINCREMENT high-water mark are kept so SSE ids keep increasing.
      CREATE TABLE change_log_new (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        entity     TEXT NOT NULL CHECK (entity IN ('work','asset','job','system')),
        entity_id  TEXT NOT NULL,
        action     TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO change_log_new (seq, entity, entity_id, action, data, created_at)
        SELECT seq, entity, entity_id, action, data, created_at FROM change_log;
      UPDATE sqlite_sequence
        SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'change_log'), 0))
        WHERE name = 'change_log_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'change_log_new', seq FROM sqlite_sequence
        WHERE name = 'change_log'
          AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'change_log_new');
      DROP TABLE change_log;
      ALTER TABLE change_log_new RENAME TO change_log;
    `,
  },
  {
    id: '0012',
    name: 'new_api_provider',
    sql: /* sql */ `
      CREATE TABLE ai_providers_new (
        provider        TEXT PRIMARY KEY CHECK (provider IN ('gemini','anthropic','openai','new-api')),
        key_set_at      TEXT,
        text_model      TEXT,
        video_model     TEXT,
        consent_version INTEGER,
        consent_at      TEXT,
        updated_at      TEXT NOT NULL,
        credential_id   TEXT
      );
      INSERT INTO ai_providers_new
        (provider, key_set_at, text_model, video_model, consent_version, consent_at, updated_at)
        SELECT provider, key_set_at, text_model, video_model, consent_version, consent_at, updated_at
        FROM ai_providers;
      DROP TABLE ai_providers;
      ALTER TABLE ai_providers_new RENAME TO ai_providers;
      -- Prevent already queued jobs from being silently sent to a replacement gateway.
      ALTER TABLE ai_jobs ADD COLUMN credential_id TEXT;
    `,
  },
  {
    id: '0013',
    name: 'asset_metadata_trash',
    sql: /* sql */ `
      -- QC-037: editable asset metadata and 最近刪除. Columns only; no rebuild.
      ALTER TABLE assets ADD COLUMN display_name TEXT;
      ALTER TABLE assets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE assets ADD COLUMN alt_text TEXT;
      ALTER TABLE assets ADD COLUMN note TEXT;
      ALTER TABLE assets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE assets ADD COLUMN deleted_at TEXT;
      ALTER TABLE assets ADD COLUMN removal TEXT
        CHECK (removal IS NULL OR removal IN ('trashed','unindexed','original_trashed'));
      CREATE INDEX assets_deleted_at ON assets (deleted_at) WHERE deleted_at IS NOT NULL;
    `,
  },
  {
    id: '0014',
    name: 'ai_job_error_detail',
    sql: /* sql */ `
      -- QC-043: untranslated technical detail of an AI failure, apart from the 繁體 text.
      ALTER TABLE ai_jobs ADD COLUMN error_detail TEXT;
    `,
  },
  {
    id: '0015',
    name: 'typed_works_media',
    sql: /* sql */ `
      -- QC-045/046: image-post and video works keep their files in front matter.
      -- media_index maps a front-matter path to the library asset it came from
      -- (JSON object), so lists and thumbnails need no hashing.
      ALTER TABLE works ADD COLUMN media_index TEXT NOT NULL DEFAULT '{}';
      -- A platform variant can follow the work's shared copy, and a video's
      -- variant can use a frame as cover.
      ALTER TABLE platform_variants ADD COLUMN inherit INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE platform_variants ADD COLUMN cover_time_seconds REAL;
      ALTER TABLE platform_variant_revisions ADD COLUMN inherit INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE platform_variant_revisions ADD COLUMN cover_time_seconds REAL;
    `,
  },
  {
    id: '0016',
    name: 'work_trash',
    sql: /* sql */ `
      -- QC-051: works in 最近刪除. Columns and one table only; see WORK_TRASH_ROLLBACK_SQL.
      ALTER TABLE works ADD COLUMN deleted_at TEXT;
      ALTER TABLE works ADD COLUMN removal TEXT
        CHECK (removal IS NULL OR removal IN ('trashed','unindexed','original_trashed'));
      CREATE INDEX works_deleted_at ON works (deleted_at) WHERE deleted_at IS NOT NULL;
      -- Files of external works deleted permanently: rescans leave them unindexed.
      CREATE TABLE work_exclusions (
        mount_id    TEXT NOT NULL REFERENCES mounts (id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (mount_id, source_path)
      );
    `,
  },
];

/**
 * Undoes `0016_work_trash` so an older build can open the database again
 * (QC-051). Works still in 最近刪除 become active again; permanently deleted
 * external files would be indexed again by the next rescan.
 */
export const WORK_TRASH_ROLLBACK_SQL = /* sql */ `
  DROP TABLE work_exclusions;
  DROP INDEX works_deleted_at;
  ALTER TABLE works DROP COLUMN removal;
  ALTER TABLE works DROP COLUMN deleted_at;
  DELETE FROM schema_migrations WHERE id = '0016';
`;
