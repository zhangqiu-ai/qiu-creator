import { suggestionsOf, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  charCount,
  PLATFORM_LIMITS,
  type AiConcreteLanguage,
  type AiFailureCode,
  type AiJobRecord,
  type AiLanguageSource,
  type AiModelChoice,
  type AiModelSource,
  type Platform,
} from '@qiu-creator/contracts';
import { interfaceLanguage } from './ai-library.js';
import { blockOf, JobWatch, messageOf, type AiBlock, type AiProviders } from './ai-session.js';
import { t } from './i18n.js';

/**
 * AI 標題 inside the platform preview (QC-076, PT-20261122-004): candidates for
 * the platform being previewed only, within its own title limit. The AI never
 * writes anything: the panel applies a candidate to that platform's version,
 * which is undoable and never touches the original.
 */

/** How the candidate was written, for the language and model tags (QC-075). */
export interface TitleMarks {
  language?: AiConcreteLanguage;
  language_source?: AiLanguageSource;
  model_source?: AiModelSource;
}

export interface TitleCandidate {
  text: string;
  chars: number;
  /** Over this platform's title limit: shown, never blocked. */
  over: boolean;
}

export interface PreviewTitleState {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  /** The platform the candidates belong to; null while nothing has been asked for. */
  platform: Platform | null;
  candidates: TitleCandidate[];
  marks: TitleMarks;
  /** The model that answered, for the candidate tags. */
  model: AiModelChoice | null;
  block: AiBlock | null;
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
}

const INITIAL: PreviewTitleState = {
  phase: 'idle',
  platform: null,
  candidates: [],
  marks: {},
  model: null,
  block: null,
  failure: null,
};

/** How many candidates one run asks for. */
export const TITLE_CANDIDATE_COUNT = 5;

export function titleLimitOf(platform: Platform): number | null {
  return PLATFORM_LIMITS[platform].titleMaxChars;
}

/** Candidates of `platform` from a finished suggestions job, longest-first ties kept in order. */
export function candidatesFor(job: AiJobRecord, platform: Platform): TitleCandidate[] | null {
  const result = suggestionsOf(job);
  if (result === null) return null;
  const limit = titleLimitOf(platform);
  const list = result.platforms.find((p) => p.platform === platform)?.titles ?? [];
  return list
    .map((c) => c.text.trim())
    .filter((text) => text !== '')
    .map((text) => ({
      text,
      chars: charCount(text),
      over: limit !== null && charCount(text) > limit,
    }));
}

export class PreviewTitleSession {
  private state: PreviewTitleState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private watch: JobWatch | null = null;
  private wanted: Platform | null = null;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly workId: string,
    private readonly providers: AiProviders,
    private readonly pollMs = 3000,
  ) {}

  get snapshot(): PreviewTitleState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<PreviewTitleState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Candidates for `platform` only, with the remembered model and language (QC-075). */
  async generate(platform: Platform, model: AiModelChoice | null): Promise<void> {
    this.stopWatch();
    this.wanted = platform;
    this.set({
      phase: 'loading',
      platform,
      candidates: [],
      marks: {},
      failure: null,
      block: null,
    });
    let picked: Awaited<ReturnType<AiProviders['pick']>>;
    try {
      picked = await this.providers.pick(model?.provider ?? null);
    } catch (err) {
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      return;
    }
    if (picked.provider === null) {
      this.set({ phase: 'idle', block: picked.block });
      return;
    }
    const chosen =
      model != null && model.provider === picked.provider.provider ? model.model : null;
    try {
      const { job } = await this.client.ai.suggest(this.workId, {
        provider: picked.provider.provider,
        ...(chosen === null ? {} : { model: chosen }),
        interface_language: interfaceLanguage(),
        platforms: [platform],
        fields: ['title'],
        count: TITLE_CANDIDATE_COUNT,
      });
      this.set({ model: { provider: picked.provider.provider, model: chosen ?? '' } });
      this.follow(job.id);
    } catch (err) {
      const block = blockOf(err);
      if (block !== null) {
        this.providers.invalidate();
        this.set({ phase: 'idle', block });
        return;
      }
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
    }
  }

  private follow(jobId: string): void {
    this.stopWatch();
    this.watch = new JobWatch(
      this.client,
      jobId,
      (job) => {
        this.onJob(job);
      },
      this.pollMs,
    );
  }

  private stopWatch(): void {
    this.watch?.stop();
    this.watch = null;
  }

  /** SSE `ai_job.*`. */
  jobChanged(jobId: string): Promise<void> {
    return this.watch?.id === jobId ? this.watch.check() : Promise.resolve();
  }

  private onJob(job: AiJobRecord): void {
    if (this.watch?.id !== job.id) return;
    const platform = this.wanted;
    if (platform === null) return;
    if (job.status === 'queued' || job.status === 'running') return;
    if (job.status === 'cancelled') {
      this.set({ phase: 'idle' });
      return;
    }
    if (job.status === 'failed') {
      this.set({
        phase: 'failed',
        failure: {
          code: job.error_code,
          message: t('ai.generateFailed'),
          detail: job.error_detail ?? null,
        },
      });
      return;
    }
    const candidates = candidatesFor(job, platform);
    if (candidates === null) {
      this.set({
        phase: 'failed',
        failure: { code: 'invalid_output', message: t('ai.failInvalidOutput') },
      });
      return;
    }
    const result = suggestionsOf(job);
    this.set({
      phase: 'ready',
      candidates,
      model: { provider: job.provider, model: job.model },
      marks:
        result === null
          ? {}
          : {
              ...(result.language === undefined ? {} : { language: result.language }),
              ...(result.language_source === undefined
                ? {}
                : { language_source: result.language_source }),
              ...(result.model_source === undefined ? {} : { model_source: result.model_source }),
            },
    });
  }

  /** 停止生成. */
  async stop(): Promise<void> {
    const id = this.watch?.id;
    this.stopWatch();
    this.set({ phase: this.state.candidates.length > 0 ? 'ready' : 'idle' });
    if (id !== undefined) await this.client.ai.stop(id).catch(() => undefined);
  }

  /** 捨棄: take the candidate list off the screen (nothing was written). */
  clear(): void {
    this.stopWatch();
    this.set({ phase: 'idle', candidates: [], failure: null });
  }

  dispose(): void {
    this.stopWatch();
    this.disposed = true;
    this.listeners.clear();
  }
}
