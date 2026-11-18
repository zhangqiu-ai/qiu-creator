import path from 'node:path';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  AssetIdParamsSchema,
  CreateWorkRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  ListWorksQuerySchema,
  ListWorksResponseSchema,
  PatchWorkRequestSchema,
  RestoreRevisionRequestSchema,
  RevisionConflictResponseSchema,
  RevisionDetailSchema,
  RevisionListResponseSchema,
  RevisionParamsSchema,
  WorkDetailSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { resolveBaseRevision, revisionEtag } from '@qiu-creator/domain';
import { z } from 'zod';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { AssetService } from './assets/asset-service.js';
import type { ServerConfig } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { ServiceError } from './errors.js';
import { ChangeFeed } from './events/change-feed.js';
import { requiredAccess } from './auth/scopes.js';
import { requirePrincipal, TokenService, type Principal } from './auth/token-service.js';
import { IdempotencyService } from './idempotency/idempotency-service.js';
import { errorBody } from './http/app-type.js';
import { JobQueue, type JobQueueOptions } from './jobs/job-queue.js';
import { Layout } from './layout.js';
import { DEFAULT_SIZE_LIMITS, type SizeLimits } from './media/detect.js';
import { resolveFfprobe } from './media/ffprobe.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerEventRoutes } from './routes/events.js';
import { registerImportRoutes, registerTokenRoutes } from './routes/imports.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMountRoutes } from './routes/mounts.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAiTextRoutes } from './routes/ai-text.js';
import { TextAiService } from './ai/text-tasks.js';
import { VideoAiService, type VideoOptions } from './ai/video-tasks.js';
import { GeminiVideoClient } from './ai/providers/gemini-video.js';
import { registerAiVideoRoutes } from './routes/ai-video.js';
import { AiService, type AiRunnerOptions } from './ai/ai-service.js';
import type { AIProvider } from './ai/provider.js';
import { AnthropicProvider } from './ai/providers/anthropic.js';
import { GeminiProvider } from './ai/providers/gemini.js';
import { OpenAIProvider } from './ai/providers/openai.js';
import { KeychainSecretStore, type SecretStore } from './ai/secret-store.js';
import type { AiProvider } from '@qiu-creator/contracts';
import { registerVariantRoutes } from './routes/variants.js';
import { VariantService } from './variants/variant-service.js';
import { sendRanged } from './http/ranged.js';
import {
  DEFAULT_SIGNED_URL_TTL_MS,
  loadOrCreateSigningKey,
  MediaUrlSigner,
  redactSignedUrl,
} from './media/url-signer.js';
import { WorkMediaService } from './media/work-media.js';
import { MountService, type MountServiceOptions } from './mounts/mount-service.js';
import { ImportService, type DownloadSettings } from './imports/import-service.js';
import { WorkService } from './works/work-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook for every authenticated `/api` request. */
    principal: Principal | null;
  }
}

export const SERVER_VERSION = '0.0.0';

export interface BuildServerOptions {
  config: Pick<ServerConfig, 'home' | 'token'> & Partial<Pick<ServerConfig, 'logLevel'>>;
  /** Enable Fastify's request logger (off in tests). */
  logger?: boolean;
  /** Per-kind upload size limits (bytes). */
  limits?: Partial<SizeLimits>;
  /**
   * ffprobe binary for video/audio metadata. `undefined` resolves from
   * `CREATORHUB_FFPROBE`, PATH and Homebrew locations; `null` disables probing.
   */
  ffprobe?: string | null;
  /** Background job queue tuning; `start: false` leaves queued jobs untouched (tests). */
  jobs?: JobQueueOptions & { start?: boolean };
  /** SSE heartbeat interval. */
  heartbeatMs?: number;
  /** Close a tus PATCH after this long without receiving bytes (default 60 s). */
  tusIdleTimeoutMs?: number;
  /** URL-import download limits; tests also inject a resolver and connect override here. */
  download?: DownloadSettings;
  /** External folder watching (stability window for half-written files, etc.). */
  mounts?: MountServiceOptions;
  /**
   * AI providers. `secrets` defaults to the macOS Keychain (refused under
   * the test runner); `baseUrls` point adapters at another origin (tests use
   * local fake servers); `providers` replaces adapters entirely.
   */
  ai?: AiRunnerOptions & {
    secrets?: SecretStore;
    baseUrls?: Partial<Record<AiProvider, string>>;
    providers?: Partial<Record<AiProvider, AIProvider>>;
    timeoutMs?: number;
    start?: boolean;
    /** Gemini video upload chunk size and processing poll (QC-023). */
    video?: VideoOptions;
  };
  /** Lifetime of signed media URLs (default 1 hour); `now` is injectable for tests. */
  signedUrls?: { ttlMs?: number; now?: () => number };
}

export interface CreatorHubServer {
  app: FastifyInstance;
  db: Db;
  layout: Layout;
  works: WorkService;
  assets: AssetService;
  feed: ChangeFeed;
  jobs: JobQueue;
  imports: ImportService;
  tokens: TokenService;
  mounts: MountService;
  media: WorkMediaService;
  signer: MediaUrlSigner;
  variants: VariantService;
  ai: AiService;
}

function isHttpError(err: unknown): err is Error & { statusCode: number } {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    typeof err.statusCode === 'number' &&
    err.statusCode >= 400 &&
    err.statusCode < 600
  );
}

export async function buildServer(options: BuildServerOptions): Promise<CreatorHubServer> {
  const { config } = options;
  const layout = new Layout(config.home);
  layout.ensureBase();
  const db = openDatabase(layout.databaseFile);
  const feed = new ChangeFeed(db);
  const tokens = new TokenService(db, config.token);
  const idempotency = new IdempotencyService(db);
  const jobs = new JobQueue(db, feed, options.jobs);
  const works = new WorkService(db, layout, undefined, feed);
  const assets = new AssetService(db, layout, feed, jobs, {
    limits: { ...DEFAULT_SIZE_LIMITS, ...options.limits },
    ffprobe:
      options.ffprobe === undefined
        ? resolveFfprobe(process.env['CREATORHUB_FFPROBE'])
        : options.ffprobe,
  });
  const imports = new ImportService(db, layout, assets, jobs, feed, options.download);
  const mounts = new MountService(db, layout, works, jobs, options.mounts);
  const signer = new MediaUrlSigner(
    loadOrCreateSigningKey(path.join(layout.home, 'data', 'media-signing.key')),
    options.signedUrls?.ttlMs ?? DEFAULT_SIGNED_URL_TTL_MS,
    options.signedUrls?.now,
  );
  const media = new WorkMediaService(works, assets, layout, signer, assets.limits);
  const variants = new VariantService(db, works, assets, media, feed);
  const aiOptions = options.ai ?? {};
  const timeoutMs = aiOptions.timeoutMs ?? 120_000;
  const adapter = (p: AiProvider) => ({ baseUrl: aiOptions.baseUrls?.[p], timeoutMs });
  const ai = new AiService(
    db,
    aiOptions.secrets ?? new KeychainSecretStore(),
    {
      gemini: aiOptions.providers?.gemini ?? new GeminiProvider(adapter('gemini')),
      anthropic: aiOptions.providers?.anthropic ?? new AnthropicProvider(adapter('anthropic')),
      openai: aiOptions.providers?.openai ?? new OpenAIProvider(adapter('openai')),
    },
    feed,
    aiOptions,
  );

  const app = Fastify({
    logger:
      options.logger === true
        ? {
            level: config.logLevel ?? 'info',
            // Signed media URLs carry a signature in the query string; never log it.
            serializers: {
              req: (req: { method: string; url: string; ip?: string }) => ({
                method: req.method,
                url: redactSignedUrl(req.url),
                remoteAddress: req.ip,
              }),
            },
          }
        : false,
    bodyLimit: 8 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onClose', async () => {
    await ai.stop();
    await mounts.stop();
    await jobs.stop();
    db.close();
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ServiceError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send(
        errorBody('validation_error', 'request does not match the schema', {
          issues: err.validation,
        }),
      );
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response serialization failed');
      return reply.code(500).send(errorBody('internal_error', 'internal error'));
    }
    const statusCode = isHttpError(err) ? err.statusCode : 500;
    if (statusCode >= 500 || !isHttpError(err)) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(500).send(errorBody('internal_error', 'internal error'));
    }
    // Fastify's own 4xx errors (malformed JSON, unsupported media type, body too large...).
    return reply.code(statusCode).send(errorBody('validation_error', err.message));
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send(errorBody('not_found', 'route not found')),
  );

  // Every /api route requires a bearer token: the owner's main token or a
  // scoped agent token. /health and /docs stay public.
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const principal = tokens.authenticate(req.headers.authorization);
    if (principal === null) {
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send(errorBody('unauthorized', 'missing or invalid bearer token'));
      return;
    }
    req.principal = principal;
    const access = requiredAccess(req.method, req.routeOptions.url);
    const allowed =
      principal.kind === 'owner' ||
      (access === 'read_or_own_import'
        ? principal.scopes.includes('read') || principal.scopes.includes('import')
        : access !== 'owner' && principal.scopes.includes(access));
    if (!allowed) {
      await reply.code(403).send(
        errorBody('forbidden', `this token lacks the "${access}" permission`, {
          required: access,
        }),
      );
    }
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'CreatorHub Mac Server', version: SERVER_VERSION },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  const errorResponses = {
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    404: ErrorResponseSchema,
  };

  app.get('/health', { schema: { security: [], response: { 200: HealthResponseSchema } } }, () => ({
    status: 'ok' as const,
    service: 'creatorhub-mac-server' as const,
    version: SERVER_VERSION,
  }));

  app.post(
    '/api/v1/works',
    {
      schema: {
        description:
          'Create a managed work. Send an `Idempotency-Key` header (required for agent tokens): repeating a request with the same key returns the original work with `Idempotent-Replayed: true` instead of creating another.',
        body: CreateWorkRequestSchema,
        response: {
          201: WorkDetailSchema,
          422: ErrorResponseSchema,
          428: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const result = idempotency.run(
        requirePrincipal(req.principal),
        'POST /api/v1/works',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        req.body,
        () => ({ statusCode: 201, body: works.create(req.body) }),
      );
      const work = WorkDetailSchema.parse(result.body);
      reply.code(result.statusCode).header('etag', revisionEtag(work.current_revision_id));
      if (result.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return work;
    },
  );

  app.get(
    '/api/v1/works',
    {
      schema: {
        querystring: ListWorksQuerySchema,
        response: { 200: ListWorksResponseSchema, ...errorResponses },
      },
    },
    (req) => works.list(req.query),
  );

  app.get(
    '/api/v1/works/:id',
    {
      schema: {
        params: WorkIdParamsSchema,
        response: { 200: WorkDetailSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      const work = works.get(req.params.id);
      reply.header('etag', revisionEtag(work.current_revision_id));
      return work;
    },
  );

  app.patch(
    '/api/v1/works/:id',
    {
      schema: {
        description:
          'Edit a work. Requires `base_revision` in the body or an `If-Match` ETag. A stale base returns 409 with the current revision; nothing is written.',
        params: WorkIdParamsSchema,
        body: PatchWorkRequestSchema,
        response: {
          200: WorkDetailSchema,
          // revision_conflict, or source_missing for an external work whose file is gone
          409: z.union([RevisionConflictResponseSchema, ErrorResponseSchema]),
          428: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const { base_revision: bodyBase, ...fields } = req.body;
      const current = works.get(req.params.id).current_revision_id;
      const ifMatch = req.headers['if-match'];
      const work = works.patch(req.params.id, {
        ...fields,
        baseRevision: resolveBaseRevision(bodyBase, ifMatch, current),
      });
      reply.header('etag', revisionEtag(work.current_revision_id));
      return work;
    },
  );

  app.get(
    '/api/v1/works/:id/revisions',
    {
      schema: {
        params: WorkIdParamsSchema,
        response: { 200: RevisionListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: works.revisions(req.params.id) }),
  );

  app.get(
    '/api/v1/works/:id/revisions/:rid',
    {
      schema: {
        description: 'One historical revision with its full Markdown snapshot and title.',
        params: RevisionParamsSchema,
        response: { 200: RevisionDetailSchema, ...errorResponses },
      },
    },
    (req) => works.revision(req.params.id, req.params.rid),
  );

  app.post(
    '/api/v1/works/:id/revisions/:rid/restore',
    {
      schema: {
        description:
          'Restore an old revision by appending a new `restore` revision with its Markdown and title (history is never rewritten; status, type and tags are unchanged). Requires `base_revision` or `If-Match`; a stale base returns 409 and nothing is written.',
        params: RevisionParamsSchema,
        body: RestoreRevisionRequestSchema,
        response: {
          200: WorkDetailSchema,
          409: z.union([RevisionConflictResponseSchema, ErrorResponseSchema]),
          428: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const current = works.get(req.params.id).current_revision_id;
      const work = works.restore(
        req.params.id,
        req.params.rid,
        resolveBaseRevision(req.body.base_revision, req.headers['if-match'], current),
      );
      reply.header('etag', revisionEtag(work.current_revision_id));
      return work;
    },
  );

  app.get(
    '/api/v1/assets/:id/stream',
    {
      schema: {
        description: 'Stream an asset file with HTTP Range support (206 / 416).',
        params: AssetIdParamsSchema,
      },
    },
    (req, reply) => sendRanged(req, reply, assets.streamTarget(req.params.id)),
  );

  registerAssetRoutes(app, assets, layout, { tusIdleTimeoutMs: options.tusIdleTimeoutMs });
  registerEventRoutes(app, feed, options.heartbeatMs);
  registerImportRoutes(app, imports, idempotency);
  registerTokenRoutes(app, tokens);
  registerMountRoutes(app, mounts);
  registerMediaRoutes(app, media, assets, signer, tokens);
  registerVariantRoutes(app, variants);
  registerAiRoutes(app, ai, idempotency);
  registerAiTextRoutes(app, new TextAiService(ai, works, variants));
  registerAiVideoRoutes(
    app,
    new VideoAiService(ai, assets, new GeminiVideoClient(adapter('gemini')), aiOptions.video),
  );

  mounts.start();
  if (options.jobs?.start !== false) jobs.start();
  if (aiOptions.start !== false) ai.start();
  return {
    app,
    db,
    layout,
    works,
    assets,
    feed,
    jobs,
    imports,
    tokens,
    mounts,
    media,
    signer,
    variants,
    ai,
  };
}
