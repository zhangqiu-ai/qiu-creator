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
  {
    id: '0017',
    name: 'projects',
    sql: /* sql */ `
      -- QC-062: projects group works (many to many). Membership lives only in
      -- SQLite, never in the works' Markdown. See PROJECTS_ROLLBACK_SQL.
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       INTEGER NOT NULL CHECK (color BETWEEN 0 AND 7),
        sort_order  INTEGER NOT NULL,
        revision    INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT,
        deleted_at  TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX projects_live_order ON projects (sort_order) WHERE deleted_at IS NULL;
      CREATE TABLE work_projects (
        work_id    TEXT NOT NULL REFERENCES works (id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        added_at   TEXT NOT NULL,
        PRIMARY KEY (work_id, project_id)
      );
      CREATE INDEX work_projects_project ON work_projects (project_id);
      -- Project events (entity 'project'): rebuild change_log as in 0011, keeping
      -- every seq and the AUTOINCREMENT high-water mark.
      CREATE TABLE change_log_new (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        entity     TEXT NOT NULL CHECK (entity IN ('work','asset','job','system','project')),
        entity_id  TEXT NOT NULL,
        action     TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO change_log_new (seq, entity, entity_id, action, data, created_at)
        SELECT seq, entity, entity_id, action, data, created_at FROM change_log
        WHERE entity IN ('work','asset','job','system','project');
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
    id: '0018',
    name: 'search_fold',
    sql: /* sql */ `
      -- QC-068: the full-text index holds text folded for search (NFKC, lower
      -- case, Traditional to Simplified by character), the same rule the app
      -- highlights with; queries are folded the same way. search_fold is a
      -- function registered on every connection (registerSqlFunctions).
      UPDATE works_fts SET
        title = search_fold(title),
        tags = search_fold(tags),
        body = search_fold(body);
    `,
  },
  {
    id: '0019',
    name: 'prompts',
    sql: /* sql */ `
      -- QC-075: the user's prompt library. Built-in prompts live in code, not
      -- here. prompt_usage records the last use of any prompt, built-ins too.
      CREATE TABLE prompts (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        group_name     TEXT,
        scene          TEXT NOT NULL CHECK (scene IN ('selection','full','title','image')),
        content        TEXT NOT NULL,
        model_provider TEXT CHECK (model_provider IS NULL OR model_provider IN ('gemini','anthropic','openai','new-api')),
        model_name     TEXT,
        language       TEXT CHECK (language IS NULL OR language IN ('follow','zh-Hans','zh-Hant','en')),
        sort_order     INTEGER NOT NULL,
        revision       INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        CHECK ((model_provider IS NULL) = (model_name IS NULL))
      );
      CREATE INDEX prompts_order ON prompts (sort_order);
      CREATE TABLE prompt_usage (
        prompt_id    TEXT PRIMARY KEY,
        use_count    INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '0020',
    name: 'variant_overrides',
    sql: /* sql */ `
      -- QC-084: a platform variant keeps only overrides; null follows the work.
      -- The body is derived from the work (deriveVariantBody); body_override
      -- holds a body the user had edited before QC-084 and can only be
      -- cleared. Old columns stay as they were (nothing is deleted).
      -- overrides_ready = 0 until the row's old values were turned into
      -- overrides, which the service does on first access because it needs the
      -- work's files (VariantService.backfill). See VARIANT_OVERRIDES_ROLLBACK_SQL.
      ALTER TABLE platform_variants ADD COLUMN title_override TEXT;
      -- {"asset_id": …} or {"time_seconds": …}
      ALTER TABLE platform_variants ADD COLUMN cover_override TEXT;
      -- {"order": [ids shown, in order], "hidden": [work images hidden], "extra": [ids not in the work]}
      ALTER TABLE platform_variants ADD COLUMN image_order_override TEXT;
      -- JSON array of tags
      ALTER TABLE platform_variants ADD COLUMN tags_override TEXT;
      ALTER TABLE platform_variants ADD COLUMN body_override TEXT;
      ALTER TABLE platform_variants ADD COLUMN overrides_ready INTEGER NOT NULL DEFAULT 0;
      -- History rows written since QC-084 record overrides (overrides_format = 1);
      -- older rows keep their full copy in the old columns.
      ALTER TABLE platform_variant_revisions ADD COLUMN title_override TEXT;
      ALTER TABLE platform_variant_revisions ADD COLUMN cover_override TEXT;
      ALTER TABLE platform_variant_revisions ADD COLUMN image_order_override TEXT;
      ALTER TABLE platform_variant_revisions ADD COLUMN tags_override TEXT;
      ALTER TABLE platform_variant_revisions ADD COLUMN body_override TEXT;
      ALTER TABLE platform_variant_revisions ADD COLUMN overrides_format INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: '0021',
    name: 'agent_proposals_activity',
    sql: /* sql */ `
      -- QC-089: agent proposals, the direct-edit switch, project limits, who
      -- did what. Columns and new tables only; see AGENT_PROPOSALS_ROLLBACK_SQL.
      ALTER TABLE api_tokens ADD COLUMN allow_direct_body_edit INTEGER NOT NULL DEFAULT 0;
      -- JSON array of project ids; NULL = every project.
      ALTER TABLE api_tokens ADD COLUMN project_ids TEXT;
      -- 'owner', an agent token id, or NULL for the service itself.
      ALTER TABLE change_log ADD COLUMN actor TEXT;
      -- The agent behind a revision: a proposal the user accepted, or a
      -- direct body edit ('proposal' | 'direct'); source stays 'edit'.
      ALTER TABLE revisions ADD COLUMN agent_token_id TEXT;
      ALTER TABLE revisions ADD COLUMN agent_name TEXT;
      ALTER TABLE revisions ADD COLUMN agent_via TEXT
        CHECK (agent_via IS NULL OR agent_via IN ('proposal','direct'));
      ALTER TABLE revisions ADD COLUMN proposal_id TEXT;

      CREATE TABLE proposals (
        id                 TEXT PRIMARY KEY,
        work_id            TEXT NOT NULL REFERENCES works (id) ON DELETE CASCADE,
        token_id           TEXT NOT NULL,
        token_name         TEXT NOT NULL,
        note               TEXT,
        status             TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','accepted','partially_accepted','discarded')),
        base_revision_id   TEXT NOT NULL,
        -- The proposed Markdown; the base text is the base revision's snapshot.
        proposed_markdown  TEXT NOT NULL,
        -- JSON array of hunks with stable ids, made when the proposal was created.
        hunks              TEXT NOT NULL,
        accepted_hunk_ids  TEXT NOT NULL DEFAULT '[]',
        result_revision_id TEXT,
        created_at         TEXT NOT NULL,
        decided_at         TEXT
      );
      CREATE INDEX proposals_pending ON proposals (work_id) WHERE status = 'pending';
      CREATE INDEX proposals_created ON proposals (created_at DESC);

      CREATE TABLE token_activity (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id    TEXT NOT NULL,
        at          TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('request','token_updated')),
        method      TEXT NOT NULL,
        route       TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        status      INTEGER NOT NULL,
        result      TEXT NOT NULL CHECK (result IN ('ok','rejected','error')),
        code        TEXT,
        reason      TEXT,
        revision    TEXT
      );
      CREATE INDEX token_activity_token ON token_activity (token_id, id DESC);
    `,
  },
  {
    id: '0022',
    name: 'project_rules_membership',
    sql: /* sql */ `
      -- QC-092: project description and rules, and who put a work in a
      -- project and why. Columns only; see PROJECT_RULES_ROLLBACK_SQL.
      ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
      -- JSON {keywords, tags, folders, domains}
      ALTER TABLE projects ADD COLUMN rules TEXT NOT NULL DEFAULT '{}';
      -- 'user' (the owner by hand), 'agent' (an agent token's choice), 'rule' (auto_assign).
      -- Existing memberships were made in the app: 'user'.
      ALTER TABLE work_projects ADD COLUMN added_by TEXT NOT NULL DEFAULT 'user'
        CHECK (added_by IN ('user','agent','rule'));
      ALTER TABLE work_projects ADD COLUMN added_by_token TEXT;
      ALTER TABLE work_projects ADD COLUMN added_by_name TEXT;
      ALTER TABLE work_projects ADD COLUMN score REAL;
      -- JSON array of reasons for 'rule' assignments.
      ALTER TABLE work_projects ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: '0023',
    name: 'project_text_script',
    sql: /* sql */ `
      -- QC-103: a project's script for text agents write into its works
      -- ('zh-Hans' or 'zh-Hant'); NULL follows the global setting, which
      -- lives in app_settings ('work_text_script'). Column only; see
      -- PROJECT_TEXT_SCRIPT_ROLLBACK_SQL.
      ALTER TABLE projects ADD COLUMN text_script TEXT
        CHECK (text_script IS NULL OR text_script IN ('zh-Hans','zh-Hant'));
    `,
  },
  {
    id: '0024',
    name: 'project_groups',
    sql: /* sql */ `
      -- QC-113: groups inside a project (one level); ordered = 1 makes a
      -- series. Groups go with their project (soft delete hides them, purge
      -- removes them). See PROJECT_GROUPS_ROLLBACK_SQL.
      CREATE TABLE project_groups (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        ordered          INTEGER NOT NULL DEFAULT 0 CHECK (ordered IN (0, 1)),
        sort_order       INTEGER NOT NULL,
        created_by       TEXT NOT NULL CHECK (created_by IN ('user','agent')),
        created_by_token TEXT,
        created_by_name  TEXT,
        revision         INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE (project_id, name)
      );
      CREATE INDEX project_groups_project ON project_groups (project_id, sort_order);
      -- A work's group in a project (NULL = 未分組) and its place in the group.
      -- No foreign key, so the rollback can drop the columns; the service
      -- clears group_id when a group is deleted, and purging a project removes
      -- its memberships and groups together.
      ALTER TABLE work_projects ADD COLUMN group_id TEXT;
      ALTER TABLE work_projects ADD COLUMN position INTEGER;
      CREATE INDEX work_projects_group ON work_projects (group_id, position)
        WHERE group_id IS NOT NULL;
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

/**
 * Undoes `0017_projects` so an older build can open the database again
 * (QC-062): projects, their memberships and their events are dropped; works
 * and their files are untouched. Sequence numbers keep increasing.
 */
export const PROJECTS_ROLLBACK_SQL = /* sql */ `
  DROP TABLE work_projects;
  DROP TABLE projects;
  CREATE TABLE change_log_new (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    entity     TEXT NOT NULL CHECK (entity IN ('work','asset','job','system')),
    entity_id  TEXT NOT NULL,
    action     TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  INSERT INTO change_log_new (seq, entity, entity_id, action, data, created_at)
    SELECT seq, entity, entity_id, action, data, created_at FROM change_log
    WHERE entity IN ('work','asset','job','system');
  UPDATE sqlite_sequence
    SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'change_log'), 0))
    WHERE name = 'change_log_new';
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'change_log_new', seq FROM sqlite_sequence
    WHERE name = 'change_log'
      AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'change_log_new');
  DROP TABLE change_log;
  ALTER TABLE change_log_new RENAME TO change_log;
  DELETE FROM schema_migrations WHERE id = '0017';
`;

/**
 * Undoes `0018_search_fold` so an older build can open the database again
 * (QC-068). The folded index cannot be unfolded in SQL, so it is left folded:
 * an older build still finds works whose text is already lower-case,
 * half-width and Simplified, and the rest as each work is saved again.
 */
export const SEARCH_FOLD_ROLLBACK_SQL = /* sql */ `
  DELETE FROM schema_migrations WHERE id = '0018';
`;

/**
 * Undoes `0019_prompts` so an older build can open the database again
 * (QC-075): the prompt library and its usage go; nothing else changes.
 * Export the library first if it should be kept.
 */
export const PROMPTS_ROLLBACK_SQL = /* sql */ `
  DROP TABLE prompt_usage;
  DROP TABLE prompts;
  DELETE FROM schema_migrations WHERE id = '0019';
`;

/**
 * Undoes `0020_variant_overrides` so an older build can open the database
 * again (QC-084). Overrides set since then are written back into the old
 * columns first (title, tags, body, cover, image order); fields that follow
 * the work keep their old value. Without writes after the migration the
 * table is exactly as before. History rows are kept.
 */
export const VARIANT_OVERRIDES_ROLLBACK_SQL = /* sql */ `
  UPDATE platform_variants SET
    title = COALESCE(title_override, title),
    tags = COALESCE(tags_override, tags),
    body = COALESCE(body_override, body),
    cover_asset_id = CASE
      WHEN cover_override IS NULL THEN cover_asset_id
      WHEN json_extract(cover_override, '$.asset_id') IN (SELECT id FROM assets)
        THEN json_extract(cover_override, '$.asset_id')
      ELSE NULL END,
    cover_time_seconds = CASE
      WHEN cover_override IS NULL THEN cover_time_seconds
      ELSE json_extract(cover_override, '$.time_seconds') END,
    image_asset_ids = COALESCE(json_extract(image_order_override, '$.order'), image_asset_ids)
  WHERE title_override IS NOT NULL OR tags_override IS NOT NULL OR body_override IS NOT NULL
    OR cover_override IS NOT NULL OR image_order_override IS NOT NULL;
  ALTER TABLE platform_variant_revisions DROP COLUMN overrides_format;
  ALTER TABLE platform_variant_revisions DROP COLUMN body_override;
  ALTER TABLE platform_variant_revisions DROP COLUMN tags_override;
  ALTER TABLE platform_variant_revisions DROP COLUMN image_order_override;
  ALTER TABLE platform_variant_revisions DROP COLUMN cover_override;
  ALTER TABLE platform_variant_revisions DROP COLUMN title_override;
  ALTER TABLE platform_variants DROP COLUMN overrides_ready;
  ALTER TABLE platform_variants DROP COLUMN body_override;
  ALTER TABLE platform_variants DROP COLUMN tags_override;
  ALTER TABLE platform_variants DROP COLUMN image_order_override;
  ALTER TABLE platform_variants DROP COLUMN cover_override;
  ALTER TABLE platform_variants DROP COLUMN title_override;
  DELETE FROM schema_migrations WHERE id = '0020';
`;

/**
 * Undoes `0021_agent_proposals_activity` so an older build can open the
 * database again (QC-089). Proposals and agent activity are dropped; the
 * revisions they made stay as ordinary `edit` revisions (only the agent
 * columns go). Older builds know neither the `propose` scope nor proposal
 * events, so both are removed; project limits and the direct-edit switch go.
 */
export const AGENT_PROPOSALS_ROLLBACK_SQL = /* sql */ `
  UPDATE api_tokens
    SET scopes = (SELECT json_group_array(value) FROM json_each(api_tokens.scopes)
                  WHERE value <> 'propose')
    WHERE EXISTS (SELECT 1 FROM json_each(api_tokens.scopes) WHERE value = 'propose');
  DELETE FROM change_log WHERE action IN ('proposal.created', 'proposal.updated');
  DROP TABLE token_activity;
  DROP TABLE proposals;
  ALTER TABLE revisions DROP COLUMN proposal_id;
  ALTER TABLE revisions DROP COLUMN agent_via;
  ALTER TABLE revisions DROP COLUMN agent_name;
  ALTER TABLE revisions DROP COLUMN agent_token_id;
  ALTER TABLE change_log DROP COLUMN actor;
  ALTER TABLE api_tokens DROP COLUMN project_ids;
  ALTER TABLE api_tokens DROP COLUMN allow_direct_body_edit;
  DELETE FROM schema_migrations WHERE id = '0021';
`;

/**
 * Undoes `0022_project_rules_membership` so an older build can open the
 * database again (QC-092): project descriptions and rules, and the record
 * of who assigned each work, are dropped; memberships themselves stay.
 */
export const PROJECT_RULES_ROLLBACK_SQL = /* sql */ `
  ALTER TABLE work_projects DROP COLUMN reasons;
  ALTER TABLE work_projects DROP COLUMN score;
  ALTER TABLE work_projects DROP COLUMN added_by_name;
  ALTER TABLE work_projects DROP COLUMN added_by_token;
  ALTER TABLE work_projects DROP COLUMN added_by;
  ALTER TABLE projects DROP COLUMN rules;
  ALTER TABLE projects DROP COLUMN description;
  DELETE FROM schema_migrations WHERE id = '0022';
`;

/**
 * Undoes `0023_project_text_script` so an older build can open the database
 * again (QC-103): project overrides go; the global setting stays in
 * app_settings, where older builds ignore it. No work text changes.
 */
export const PROJECT_TEXT_SCRIPT_ROLLBACK_SQL = /* sql */ `
  ALTER TABLE projects DROP COLUMN text_script;
  DELETE FROM schema_migrations WHERE id = '0023';
`;

/**
 * Undoes `0024_project_groups` so an older build can open the database again
 * (QC-113): groups and every work's group and place are dropped; works stay
 * in their projects (in 未分組 when this build runs again).
 */
export const PROJECT_GROUPS_ROLLBACK_SQL = /* sql */ `
  DROP INDEX work_projects_group;
  ALTER TABLE work_projects DROP COLUMN position;
  ALTER TABLE work_projects DROP COLUMN group_id;
  DROP INDEX project_groups_project;
  DROP TABLE project_groups;
  DELETE FROM schema_migrations WHERE id = '0024';
`;
