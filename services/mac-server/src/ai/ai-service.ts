import { randomUUID } from 'node:crypto';
import {
  AI_DEFAULT_MODELS,
  AI_NOTICE_VERSION,
  AI_PRICE_TABLE,
  AI_PRICES_AS_OF,
  AI_PROVIDER_NAMES,
  AiCostEstimateSchema,
  AiJobRecordSchema,
  AiProviderSchema,
  AiSettingsSchema,
  AiTextInputSchema,
  aiConsentNotice,
  aiNoticeTemplate,
  costUsd,
  CreateAiJobRequestSchema,
  estimateTokens,
  IdSchema,
  ListAiJobsQuerySchema,
  SetAiKeyRequestSchema,
  type AiBudgetStatus,
  type AiCostEstimate,
  type AiFailureCode,
  type AiJobRecord,
  type AiModelPrice,
  type AiProvider,
  type AiProviderStatus,
  type AiSettings,
  type AiTask,
  AiTaskSchema,
  type AiTextInput,
  type AiUsageResponse,
  type ChangeAction,
  type CreateAiJobRequest,
  type ListAiJobsQuery,
  type ListAiJobsResponse,
  type PatchAiProviderRequest,
  type PatchAiSettingsRequest,
} from '@qiu-creator/contracts';
import { sha256Hex } from '@qiu-creator/domain';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import { canonicalJson } from '../idempotency/idempotency-service.js';
import {
  isAbort,
  ProviderError,
  providerError,
  type AIProvider,
  type AiTextResult,
} from './provider.js';
import type { SecretStore } from './secret-store.js';

export interface AiRunnerOptions {
  /** Jobs running at once (default 2). AI calls are slow and I/O bound. */
  concurrency?: number;
  /** Base for exponential retry backoff (default 5 s). */
  retryBaseMs?: number;
  /** Idle poll interval (default 1 s); submit/retry also wake the runner. */
  pollMs?: number;
  /** Local-month clock for usage accounting (tests). */
  now?: () => Date;
}

interface ProviderRow {
  provider: string;
  key_set_at: string | null;
  credential_id: string | null;
  text_model: string | null;
  video_model: string | null;
  consent_version: number | null;
  consent_at: string | null;
  updated_at: string;
}

interface JobRow {
  id: string;
  work_id: string | null;
  model: string;
  action: string;
  source_revision: string | null;
  status: string;
  result: string | null;
  usage: string | null;
  cost_estimate: number | null;
  error: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
  /** Null on legacy `ai_jobs` rows from before QC-021, which this service ignores. */
  provider: string | null;
  input: string;
  error_code: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string | null;
  started_at: string | null;
  finished_at: string | null;
  usage_month: string | null;
  estimate: string;
  task: string | null;
  accepted_revision_id: string | null;
  accepted_at: string | null;
  cache_key: string | null;
  progress: string | null;
  remote_state: string | null;
  credential_id: string | null;
}

export type AiJobProgress = NonNullable<AiJobRecord['progress']>;

/**
 * Runs a task type instead of a plain `generateText` call (QC-023: upload a
 * video, wait for the provider, then generate). Must honour `signal` and may
 * persist resume state so a retry continues where the last attempt stopped.
 */
export type AiTaskExecutor = (ctx: {
  job: {
    id: string;
    model: string;
    work_id: string | null;
    task: AiTask;
    /** What the previous attempt saved with `saveRemoteState`, if anything. */
    remoteState: unknown;
  };
  input: AiTextInput;
  apiKey: string;
  signal: AbortSignal;
  reportProgress: (progress: AiJobProgress) => void;
  saveRemoteState: (state: unknown) => void;
  /**
   * True once the service is stopping. An abort then means "the service is
   * going down", not "the user cancelled": keep remote state for the next run.
   */
  shuttingDown: () => boolean;
}) => Promise<AiTextResult>;

/**
 * Shapes a task's raw provider output into its stored `result` (QC-022).
 * Throw `ProviderError('invalid_output')` when the output cannot be used.
 */
export type AiTaskFinalizer = (
  output: { text: string; json: unknown },
  task: AiTask,
  job: { id: string; work_id: string | null; source_revision: string | null },
) => { text: string; json?: unknown };

const SETTINGS_KEY = 'ai';
const NewApiCredentialSchema = SetAiKeyRequestSchema.required().extend({ id: IdSchema });

function localMonth(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function parseJson(raw: string | null): unknown {
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

/**
 * AI foundation: provider settings, Keychain-backed keys, first-use consent,
 * cost estimates and the monthly reminder, and a durable job runner.
 *
 * Nothing is sent to a provider unless the user created a job, the provider
 * has a stored key and the current notice version is confirmed (both are
 * checked again right before the call). Keys are read from the SecretStore
 * at call time only and never stored, returned or logged.
 */
export class AiService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly concurrency: number;
  private readonly retryBaseMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private changingNewApiCredential = false;
  private active = 0;
  private readonly inflight = new Set<Promise<void>>();
  private readonly finalizers = new Map<AiTask['type'], AiTaskFinalizer>();
  private readonly executors = new Map<AiTask['type'], AiTaskExecutor>();

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly providers: Readonly<Record<AiProvider, AIProvider>>,
    private readonly feed?: ChangeFeed,
    options: AiRunnerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 5000;
    this.pollMs = options.pollMs ?? 1000;
    this.now = options.now ?? (() => new Date());
  }

  // ---- Providers, keys, consent ------------------------------------------------

  listProviders(): AiProviderStatus[] {
    return AiProviderSchema.options.map((p) => this.providerStatus(p));
  }

  providerStatus(provider: AiProvider): AiProviderStatus {
    const row = this.providerRow(provider);
    const consentValid = row?.consent_version === AI_NOTICE_VERSION && row.consent_at !== null;
    const keyConfigured = row?.key_set_at !== null && row?.key_set_at !== undefined;
    return {
      provider,
      ...AI_PROVIDER_NAMES[provider],
      key_configured: keyConfigured,
      key_updated_at: row?.key_set_at ?? null,
      text_model: row?.text_model ?? AI_DEFAULT_MODELS[provider].text,
      video_model:
        AI_DEFAULT_MODELS[provider].video === null
          ? null
          : (row?.video_model ?? AI_DEFAULT_MODELS[provider].video),
      notice: {
        version: AI_NOTICE_VERSION,
        text: aiConsentNotice(provider),
        ...aiNoticeTemplate(provider),
        ...(row?.credential_id ? { credential_id: row.credential_id } : {}),
      },
      consent:
        consentValid && row.consent_at !== null && row.consent_version !== null
          ? { version: row.consent_version, at: row.consent_at }
          : null,
      ready: keyConfigured && consentValid,
    };
  }

  async setKey(provider: AiProvider, apiKey: string, baseUrl?: string): Promise<AiProviderStatus> {
    if (provider === 'new-api') {
      if (baseUrl === undefined) {
        throw new ServiceError(400, 'validation_error', 'New API requires a Base URL');
      }
      return this.changeNewApiCredential({ api_key: apiKey, base_url: baseUrl, id: randomUUID() });
    }
    if (baseUrl !== undefined) {
      throw new ServiceError(400, 'validation_error', 'only New API accepts a Base URL');
    }
    await this.secrets.set(provider, apiKey);
    this.upsertProvider(provider, { key_set_at: this.now().toISOString() });
    return this.providerStatus(provider);
  }

  async deleteKey(provider: AiProvider): Promise<AiProviderStatus> {
    if (provider === 'new-api') return this.changeNewApiCredential(null);
    await this.secrets.delete(provider);
    this.upsertProvider(provider, { key_set_at: null });
    return this.providerStatus(provider);
  }

  private async changeNewApiCredential(
    credential: { id: string; api_key: string; base_url: string } | null,
  ): Promise<AiProviderStatus> {
    if (this.changingNewApiCredential) {
      throw new ServiceError(
        409,
        'ai_credentials_busy',
        'a New API settings update is already in progress',
      );
    }
    this.changingNewApiCredential = true;
    try {
      try {
        if (credential === null) await this.secrets.delete('new-api');
        else await this.secrets.set('new-api', JSON.stringify(credential));
      } catch {
        throw new ServiceError(
          500,
          'internal_error',
          'could not update the New API Keychain entry',
        );
      }
      this.upsertProvider('new-api', {
        credential_id: credential?.id ?? null,
        key_set_at: credential === null ? null : this.now().toISOString(),
        consent_version: null,
        consent_at: null,
      });
      return this.providerStatus('new-api');
    } finally {
      this.changingNewApiCredential = false;
    }
  }

  consent(provider: AiProvider, noticeVersion: number, credentialId?: string): AiProviderStatus {
    const currentCredentialId = this.providerStatus(provider).notice.credential_id;
    if (
      noticeVersion !== AI_NOTICE_VERSION ||
      (provider === 'new-api' &&
        (currentCredentialId === undefined || currentCredentialId !== credentialId))
    ) {
      throw new ServiceError(
        409,
        'ai_consent_required',
        'the notice has changed; show the current notice and confirm it',
        { notice_version: AI_NOTICE_VERSION },
      );
    }
    this.upsertProvider(provider, {
      consent_version: noticeVersion,
      consent_at: this.now().toISOString(),
    });
    return this.providerStatus(provider);
  }

  withdrawConsent(provider: AiProvider): AiProviderStatus {
    this.upsertProvider(provider, { consent_version: null, consent_at: null });
    return this.providerStatus(provider);
  }

  patchProvider(provider: AiProvider, patch: PatchAiProviderRequest): AiProviderStatus {
    if (patch.video_model !== undefined && AI_DEFAULT_MODELS[provider].video === null) {
      throw new ServiceError(400, 'validation_error', 'only Gemini handles video', {
        provider,
      });
    }
    this.upsertProvider(provider, {
      ...(patch.text_model === undefined ? {} : { text_model: patch.text_model }),
      ...(patch.video_model === undefined ? {} : { video_model: patch.video_model }),
    });
    return this.providerStatus(provider);
  }

  // ---- Settings, prices, budget -------------------------------------------------------

  settings(): AiSettings {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM app_settings WHERE key = ?')
      .get(SETTINGS_KEY);
    const stored = row === undefined ? {} : (JSON.parse(row.value) as Record<string, unknown>);
    return AiSettingsSchema.parse({
      monthly_budget_usd: null,
      price_overrides: {},
      ...stored,
      prices_as_of: AI_PRICES_AS_OF,
    });
  }

  patchSettings(patch: PatchAiSettingsRequest): AiSettings {
    const current = this.settings();
    const next = {
      monthly_budget_usd:
        patch.monthly_budget_usd === undefined
          ? current.monthly_budget_usd
          : patch.monthly_budget_usd,
      price_overrides: patch.price_overrides ?? current.price_overrides,
    };
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(next), this.now().toISOString());
    return this.settings();
  }

  price(model: string, provider?: AiProvider): AiModelPrice | null {
    const overrides = this.settings().price_overrides;
    if (Object.hasOwn(overrides, model)) return overrides[model] ?? null;
    if (provider === 'new-api' || !Object.hasOwn(AI_PRICE_TABLE, model)) return null;
    return AI_PRICE_TABLE[model] ?? null;
  }

  estimate(request: CreateAiJobRequest): AiCostEstimate {
    const req = CreateAiJobRequestSchema.parse(request);
    const model = req.model ?? this.providerStatus(req.provider).text_model;
    const inputTokens =
      estimateTokens(req.input.prompt) +
      estimateTokens(req.input.system ?? '') +
      (req.input.json_schema === undefined
        ? 0
        : estimateTokens(JSON.stringify(req.input.json_schema))) +
      // Role/format overhead.
      16;
    const price = this.price(model, req.provider);
    return AiCostEstimateSchema.parse({
      provider: req.provider,
      model,
      input_tokens: inputTokens,
      max_output_tokens: req.input.max_output_tokens,
      max_cost_usd:
        price === null ? null : costUsd(price, inputTokens, req.input.max_output_tokens),
      price,
      estimated: true,
    });
  }

  budget(month: string = localMonth(this.now()), extraUsd: number | null = null): AiBudgetStatus {
    const spent =
      this.db
        .prepare<[string], { total: number | null }>(
          'SELECT sum(cost_estimate) AS total FROM ai_jobs WHERE usage_month = ?',
        )
        .get(month)?.total ?? 0;
    const budget = this.settings().monthly_budget_usd;
    const projected = extraUsd === null ? null : spent + extraUsd;
    const over = budget !== null && (projected ?? spent) > budget;
    return {
      month,
      spent_usd: spent,
      budget_usd: budget,
      projected_usd: projected,
      over_budget: over,
      warning: over
        ? `本月 AI 費用估算 ${(projected ?? spent).toFixed(2)} 美元，已超過你設定的提醒金額 ${budget.toFixed(2)} 美元。任務仍會送出。`
        : null,
    };
  }

  usage(month: string = localMonth(this.now())): AiUsageResponse {
    const rows = this.db
      .prepare<
        [string],
        { provider: string; jobs: number; cost: number | null; usage: string | null }
      >(
        `SELECT provider, 1 AS jobs, cost_estimate AS cost, usage FROM ai_jobs
         WHERE usage_month = ?`,
      )
      .all(month);
    const by = new Map<
      AiProvider,
      { jobs: number; input_tokens: number; output_tokens: number; cost_usd: number }
    >();
    for (const row of rows) {
      const provider = AiProviderSchema.parse(row.provider);
      const entry = by.get(provider) ?? { jobs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      const usage = parseJson(row.usage) as {
        input_tokens?: number;
        output_tokens?: number;
      } | null;
      entry.jobs += 1;
      entry.input_tokens += usage?.input_tokens ?? 0;
      entry.output_tokens += usage?.output_tokens ?? 0;
      entry.cost_usd += row.cost ?? 0;
      by.set(provider, entry);
    }
    return {
      month,
      by_provider: [...by.entries()].map(([provider, v]) => ({ provider, ...v })),
      budget: this.budget(month),
      prices_as_of: AI_PRICES_AS_OF,
    };
  }

  // ---- Jobs ------------------------------------------------------------------------------

  /** Register a custom executor for a task type (replaces the plain text call). */
  registerExecutor(type: AiTask['type'], execute: AiTaskExecutor): void {
    this.executors.set(type, execute);
  }

  /** The newest job with this cache key in one of `statuses`, if any. */
  findByCacheKey(
    cacheKey: string,
    statuses: readonly AiJobRecord['status'][],
  ): AiJobRecord | undefined {
    const row = this.db
      .prepare<[string], JobRow>(
        `SELECT * FROM ai_jobs WHERE cache_key = ? AND provider IS NOT NULL
         ORDER BY coalesce(finished_at, created_at) DESC, rowid DESC`,
      )
      .all(cacheKey)
      .find((r) => statuses.includes(r.status as AiJobRecord['status']));
    return row === undefined ? undefined : toRecord(row);
  }

  /** Register how a task type's output becomes its stored result. */
  registerFinalizer(type: AiTask['type'], finalize: AiTaskFinalizer): void {
    this.finalizers.set(type, finalize);
  }

  /**
   * Queue a job. Refuses (409) unless the provider has a key and the current
   * notice is confirmed. Over budget only adds a warning.
   */
  submit(
    request: CreateAiJobRequest,
    options: { task?: AiTask; cacheKey?: string; estimate?: AiCostEstimate } = {},
  ): { job: AiJobRecord; budget: AiBudgetStatus } {
    const req = CreateAiJobRequestSchema.parse(request);
    const credentialId = this.assertReady(req.provider);
    if (req.work_id !== undefined) {
      const work = this.db
        .prepare<[string], { id: string }>('SELECT id FROM works WHERE id = ?')
        .get(req.work_id);
      if (!work) throw notFound('work');
    }
    if (req.source_revision !== undefined) {
      const rev = this.db
        .prepare<[string], { work_id: string }>(
          'SELECT work_id FROM revisions WHERE revision_id = ?',
        )
        .get(req.source_revision);
      if (rev === undefined || (req.work_id !== undefined && rev.work_id !== req.work_id)) {
        throw notFound('revision');
      }
    }
    const estimate = options.estimate ?? this.estimate(req);
    const id = randomUUID();
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ai_jobs (id, work_id, model, action, source_revision, status, created_at,
             updated_at, provider, input, attempts, max_attempts, run_after, estimate, task, cache_key,
             credential_id)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, 3, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          req.work_id ?? null,
          estimate.model,
          req.action,
          req.source_revision ?? null,
          now,
          now,
          req.provider,
          JSON.stringify(req.input),
          now,
          JSON.stringify(estimate),
          options.task === undefined ? null : JSON.stringify(options.task),
          options.cacheKey ?? null,
          credentialId,
        );
      this.event(id, 'ai_job.queued', req.provider);
    })();
    this.wake();
    return { job: this.get(id), budget: this.budget(undefined, estimate.max_cost_usd ?? 0) };
  }

  /**
   * Queue a job unless an identical one is already queued or running (QC-029):
   * same provider, resolved model, action, work, `source_revision`, input and
   * task. Then that job is returned with `in_progress: true` and nothing is
   * sent or charged again. Finished jobs never count, so asking again after
   * one finishes generates again. Check and insert run synchronously, so two
   * requests in this process cannot both queue.
   */
  submitOnce(
    request: CreateAiJobRequest,
    options: { task?: AiTask } = {},
  ): { job: AiJobRecord; budget: AiBudgetStatus; in_progress: boolean } {
    const req = CreateAiJobRequestSchema.parse(request);
    const estimate = this.estimate(req);
    const cacheKey = sha256Hex(
      canonicalJson([
        'in_flight',
        req.provider,
        ...(req.provider === 'new-api' ? [this.assertReady(req.provider)] : []),
        estimate.model,
        req.action,
        req.work_id ?? null,
        req.source_revision ?? null,
        req.input,
        options.task ?? null,
      ]),
    );
    const inflight = this.findByCacheKey(cacheKey, ['queued', 'running']);
    if (inflight !== undefined) return { job: inflight, budget: this.budget(), in_progress: true };
    return { ...this.submit(req, { ...options, cacheKey, estimate }), in_progress: false };
  }

  get(id: string): AiJobRecord {
    const row = this.db.prepare<[string], JobRow>('SELECT * FROM ai_jobs WHERE id = ?').get(id);
    if (!row || row.provider === null) throw notFound('AI job');
    return toRecord(row);
  }

  list(query: ListAiJobsQuery = {}): ListAiJobsResponse {
    const q = ListAiJobsQuerySchema.parse(query);
    const where = ['provider IS NOT NULL'];
    const params: (string | number)[] = [];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.work_id) {
      where.push('work_id = ?');
      params.push(q.work_id);
    }
    const sql = `FROM ai_jobs WHERE ${where.join(' AND ')}`;
    const total =
      this.db
        .prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n ${sql}`)
        .get(...params)?.n ?? 0;
    const rows = this.db
      .prepare<(string | number)[], JobRow>(
        `SELECT * ${sql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset);
    return { items: rows.map(toRecord), total, limit: q.limit, offset: q.offset };
  }

  /** Store and publish progress of a running job (QC-023). Silently ignored once it finished. */
  private setProgress(id: string, provider: AiProvider, progress: AiJobProgress): void {
    if (!this.db.open) return;
    const updated = this.db
      .prepare(
        "UPDATE ai_jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(JSON.stringify(progress), this.now().toISOString(), id);
    if (updated.changes === 1) {
      this.feed?.record('job', id, 'ai_job.progress', { status: 'running', provider, ...progress });
    }
  }

  /** Record that a job's candidate became `revisionId` (QC-022). */
  markAccepted(id: string, revisionId: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        'UPDATE ai_jobs SET accepted_revision_id = ?, accepted_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(revisionId, now, now, id);
  }

  /** Cancel a queued or running job; a running call is aborted. */
  cancel(id: string): AiJobRecord {
    const job = this.get(id);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new ServiceError(409, 'job_not_cancellable', `job is already ${job.status}`, {
        status: job.status,
      });
    }
    this.finish(id, job.provider, 'cancelled', { error: '已取消', error_code: null });
    this.controllers.get(id)?.abort();
    return this.get(id);
  }

  /** Re-queue a failed or cancelled job with a fresh attempt budget. */
  retry(id: string): AiJobRecord {
    const job = this.get(id);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new ServiceError(
        409,
        'job_not_retryable',
        `only failed or cancelled jobs can be retried`,
        {
          status: job.status,
        },
      );
    }
    const credentialId = this.assertReady(job.provider);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL, error_code = NULL,
             error_detail = NULL,
             run_after = ?, updated_at = ?, finished_at = NULL, credential_id = ? WHERE id = ?`,
        )
        .run(now, now, credentialId, id);
      this.event(id, 'ai_job.queued', job.provider);
    })();
    this.wake();
    return this.get(id);
  }

  // ---- Runner ------------------------------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Jobs left running by a crash or shutdown go back to the queue.
    this.db
      .prepare(
        "UPDATE ai_jobs SET status = 'queued', run_after = ?, updated_at = ? WHERE status = 'running' AND provider IS NOT NULL",
      )
      .run(this.now().toISOString(), this.now().toISOString());
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.inflight]);
  }

  /** Wait until no job is queued or running, retries included (tests). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = this.db
        .prepare<[], { n: number }>(
          "SELECT count(*) AS n FROM ai_jobs WHERE provider IS NOT NULL AND status IN ('queued','running')",
        )
        .get();
      if ((pending?.n ?? 0) === 0 && this.inflight.size === 0) return;
      if (Date.now() > deadline) throw new Error('AI jobs did not drain in time');
      this.wake();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private wake(): void {
    if (!this.stopped) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick();
    }, ms);
  }

  private tick(): void {
    if (this.stopped || !this.db.open) return;
    while (this.active < this.concurrency) {
      const row = this.claim();
      if (row === undefined) break;
      this.active++;
      const p = this.run(row).finally(() => {
        this.active--;
        this.inflight.delete(p);
        this.wake();
      });
      this.inflight.add(p);
    }
    this.schedule(this.pollMs);
  }

  /** Atomically move the next due job to `running`. */
  private claim(): JobRow | undefined {
    const now = this.now().toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare<[string], JobRow>(
          `SELECT * FROM ai_jobs WHERE provider IS NOT NULL AND status = 'queued' AND run_after <= ?
           ORDER BY run_after, created_at LIMIT 1`,
        )
        .get(now);
      if (row === undefined) return undefined;
      this.db
        .prepare(
          `UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(now, now, row.id);
      this.event(row.id, 'ai_job.running', row.provider ?? '');
      return { ...row, status: 'running', attempts: row.attempts + 1 };
    })();
  }

  private async run(row: JobRow): Promise<void> {
    const provider = AiProviderSchema.parse(row.provider);
    const input: AiTextInput = AiTextInputSchema.parse(JSON.parse(row.input));
    const controller = new AbortController();
    this.controllers.set(row.id, controller);
    let apiKey: string | null = null;
    try {
      const status = this.providerStatus(provider);
      if (status.consent === null) throw providerError('consent_required');
      const savedCredential = await this.secrets.get(provider);
      if (savedCredential === null) throw providerError('missing_key');
      let baseUrl: string | undefined;
      if (provider === 'new-api') {
        const credential = NewApiCredentialSchema.safeParse(parseJson(savedCredential));
        if (!credential.success) throw providerError('missing_key');
        const current = this.providerStatus(provider);
        if (
          current.consent === null ||
          row.credential_id !== current.notice.credential_id ||
          credential.data.id !== row.credential_id
        ) {
          throw providerError('credential_changed');
        }
        apiKey = credential.data.api_key;
        baseUrl = credential.data.base_url;
      } else {
        apiKey = savedCredential;
      }
      const task = row.task === null ? null : AiTaskSchema.parse(JSON.parse(row.task));
      const execute = task === null ? undefined : this.executors.get(task.type);
      const result =
        task !== null && execute !== undefined
          ? await execute({
              job: {
                id: row.id,
                model: row.model,
                work_id: row.work_id,
                task,
                remoteState: parseJson(row.remote_state),
              },
              input,
              apiKey,
              signal: controller.signal,
              reportProgress: (progress) => {
                this.setProgress(row.id, provider, progress);
              },
              saveRemoteState: (state) => {
                this.db
                  .prepare('UPDATE ai_jobs SET remote_state = ? WHERE id = ?')
                  .run(
                    state === null || state === undefined ? null : JSON.stringify(state),
                    row.id,
                  );
              },
              shuttingDown: () => this.stopped,
            })
          : await this.providers[provider].generateText(
              {
                model: row.model,
                system: input.system,
                prompt: input.prompt,
                jsonSchema: input.json_schema,
                maxOutputTokens: input.max_output_tokens,
                signal: controller.signal,
              },
              apiKey,
              baseUrl,
            );
      if (this.isCancelled(row.id)) return;
      let json: unknown;
      if (input.json_schema !== undefined) {
        try {
          json = JSON.parse(result.text);
        } catch {
          this.recordUsage(row, provider, result.model, result.usage);
          throw providerError(
            'invalid_output',
            result.finish === 'max_tokens' ? 'output was cut off at max_output_tokens' : undefined,
          );
        }
      }
      this.recordUsage(row, provider, result.model, result.usage);
      const finalize = task === null ? undefined : this.finalizers.get(task.type);
      const shaped =
        task === null || finalize === undefined
          ? json === undefined
            ? { text: result.text }
            : { text: result.text, json }
          : finalize({ text: result.text, json }, task, {
              id: row.id,
              work_id: row.work_id,
              source_revision: row.source_revision,
            });
      this.finish(row.id, provider, 'succeeded', {
        result: JSON.stringify(shaped),
        error: null,
        error_code: null,
      });
    } catch (err) {
      if (this.isCancelled(row.id) || isAbort(err, controller.signal)) return;
      const failure =
        err instanceof ProviderError
          ? err
          : providerError('unknown', err instanceof Error ? err.message : undefined);
      // Never let the key reach the stored message, whatever the provider echoed.
      const scrub = (text: string): string =>
        apiKey === null || apiKey === '' ? text : text.split(apiKey).join('[REDACTED]');
      const message = scrub(failure.message);
      const detail = failure.detail === null ? null : scrub(failure.detail);
      if (failure.retryable && row.attempts < row.max_attempts) {
        const delay = this.retryBaseMs * 2 ** (row.attempts - 1);
        const at = new Date(this.now().getTime() + delay).toISOString();
        this.db
          .prepare(
            `UPDATE ai_jobs SET status = 'queued', run_after = ?, error = ?, error_code = ?,
               error_detail = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(at, message, failure.code, detail, this.now().toISOString(), row.id);
        this.event(row.id, 'ai_job.queued', provider);
        return;
      }
      this.finish(row.id, provider, 'failed', {
        error: message,
        error_code: failure.code,
        error_detail: detail,
      });
    } finally {
      this.controllers.delete(row.id);
    }
  }

  private isCancelled(id: string): boolean {
    const row = this.db
      .prepare<[string], { status: string }>('SELECT status FROM ai_jobs WHERE id = ?')
      .get(id);
    return row?.status === 'cancelled';
  }

  /** Usage counts toward the month it was billed in, also for failed parses. */
  private recordUsage(
    job: JobRow,
    provider: AiProvider,
    servedModel: string,
    usage: { input_tokens: number; output_tokens: number },
  ): void {
    // Keep the gateway's configured alias for estimates and subsequent retries.
    const model = provider === 'new-api' ? job.model : servedModel;
    const price = this.price(model, provider);
    this.db
      .prepare(
        'UPDATE ai_jobs SET usage = ?, cost_estimate = ?, usage_month = ?, model = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        JSON.stringify(usage),
        price === null ? null : costUsd(price, usage.input_tokens, usage.output_tokens),
        localMonth(this.now()),
        model,
        this.now().toISOString(),
        job.id,
      );
  }

  private finish(
    id: string,
    provider: AiProvider,
    status: 'succeeded' | 'failed' | 'cancelled',
    fields: {
      result?: string;
      error: string | null;
      error_code: AiFailureCode | null;
      error_detail?: string | null;
    },
  ): void {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE ai_jobs SET status = ?, result = coalesce(?, result), error = ?, error_code = ?,
             error_detail = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued','running')`,
        )
        .run(
          status,
          fields.result ?? null,
          fields.error,
          fields.error_code,
          fields.error_detail ?? null,
          now,
          now,
          id,
        );
      if (updated.changes === 1) {
        this.event(id, `ai_job.${status}`, provider);
      }
    })();
  }

  private assertReady(provider: AiProvider): string | null {
    const status = this.providerStatus(provider);
    if (!status.key_configured) {
      throw new ServiceError(409, 'ai_key_missing', `no API key stored for ${status.name}`, {
        provider,
      });
    }
    if (status.consent === null) {
      throw new ServiceError(
        409,
        'ai_consent_required',
        `confirm the ${status.name} notice before sending content to ${status.company}`,
        { provider, notice_version: AI_NOTICE_VERSION },
      );
    }
    return status.notice.credential_id ?? null;
  }

  private event(id: string, action: ChangeAction, provider: string): void {
    this.feed?.record('job', id, action, { status: action.slice('ai_job.'.length), provider });
  }

  private providerRow(provider: AiProvider): ProviderRow | undefined {
    return this.db
      .prepare<[string], ProviderRow>('SELECT * FROM ai_providers WHERE provider = ?')
      .get(provider);
  }

  private upsertProvider(
    provider: AiProvider,
    fields: Partial<Omit<ProviderRow, 'provider' | 'updated_at'>>,
  ): void {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO ai_providers (provider, updated_at) VALUES (?, ?) ON CONFLICT (provider) DO NOTHING',
        )
        .run(provider, now);
      const entries: [string, string | number | null | undefined][] = Object.entries(fields);
      if (entries.length === 0) return;
      this.db
        .prepare(
          `UPDATE ai_providers SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE provider = ?`,
        )
        .run(...entries.map(([, v]) => v ?? null), now, provider);
    })();
  }
}

function toRecord(row: JobRow): AiJobRecord {
  return AiJobRecordSchema.parse({
    id: row.id,
    provider: row.provider,
    model: row.model,
    action: row.action,
    work_id: row.work_id,
    source_revision: row.source_revision,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    error_code: row.error_code,
    error: row.error,
    error_detail: row.error_detail,
    result: parseJson(row.result),
    usage: parseJson(row.usage),
    cost_usd: row.cost_estimate,
    estimate: JSON.parse(row.estimate) as unknown,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    task: parseJson(row.task),
    accepted_revision_id: row.accepted_revision_id,
    progress: parseJson(row.progress),
  });
}
