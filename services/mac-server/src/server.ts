import fs from 'node:fs';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  AssetIdParamsSchema,
  CreateWorkRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListWorksQuerySchema,
  ListWorksResponseSchema,
  PatchWorkRequestSchema,
  RevisionConflictResponseSchema,
  RevisionListResponseSchema,
  WorkDetailSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { parseRange, resolveBaseRevision, revisionEtag } from '@qiu-creator/domain';
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
import { errorBody } from './http/app-type.js';
import { isAuthorized } from './http/auth.js';
import { JobQueue, type JobQueueOptions } from './jobs/job-queue.js';
import { Layout } from './layout.js';
import { DEFAULT_SIZE_LIMITS, type SizeLimits } from './media/detect.js';
import { resolveFfprobe } from './media/ffprobe.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerEventRoutes } from './routes/events.js';
import { WorkService } from './works/work-service.js';

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
}

export interface CreatorHubServer {
  app: FastifyInstance;
  db: Db;
  layout: Layout;
  works: WorkService;
  assets: AssetService;
  feed: ChangeFeed;
  jobs: JobQueue;
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
  const jobs = new JobQueue(db, feed, options.jobs);
  const works = new WorkService(db, layout, undefined, feed);
  const assets = new AssetService(db, layout, feed, jobs, {
    limits: { ...DEFAULT_SIZE_LIMITS, ...options.limits },
    ffprobe:
      options.ffprobe === undefined
        ? resolveFfprobe(process.env['CREATORHUB_FFPROBE'])
        : options.ffprobe,
  });

  const app = Fastify({
    logger: options.logger === true ? { level: config.logLevel ?? 'info' } : false,
    bodyLimit: 8 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onClose', async () => {
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

  // Every /api route requires the bearer token; /health and /docs stay public.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!isAuthorized(req.headers.authorization, config.token)) {
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send(errorBody('unauthorized', 'missing or invalid bearer token'));
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
        body: CreateWorkRequestSchema,
        response: { 201: WorkDetailSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      const work = works.create(req.body);
      reply.code(201).header('etag', revisionEtag(work.current_revision_id));
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
          409: RevisionConflictResponseSchema,
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
    '/api/v1/assets/:id/stream',
    {
      schema: {
        description: 'Stream an asset file with HTTP Range support (206 / 416).',
        params: AssetIdParamsSchema,
      },
    },
    (req, reply) => {
      const target = assets.streamTarget(req.params.id);
      reply.header('accept-ranges', 'bytes').header('content-type', target.mimeType);
      const range = parseRange(req.headers.range, target.size);
      if (range.kind === 'unsatisfiable') {
        return reply
          .code(416)
          .header('content-range', `bytes */${target.size}`)
          .header('content-type', 'application/json; charset=utf-8')
          .send(errorBody('range_not_satisfiable', 'requested range is outside the file'));
      }
      if (range.kind === 'partial') {
        const { start, end } = range.range;
        return reply
          .code(206)
          .header('content-range', `bytes ${start}-${end}/${target.size}`)
          .header('content-length', end - start + 1)
          .send(fs.createReadStream(target.absPath, { start, end }));
      }
      // Bound the stream to the stat'ed size: an unbounded ReadStream kept the
      // keep-alive connection busy after the body was sent, blocking app.close().
      // It also keeps Content-Length truthful if the file grows while streaming.
      const body =
        target.size === 0
          ? Buffer.alloc(0)
          : fs.createReadStream(target.absPath, { start: 0, end: target.size - 1 });
      return reply.code(200).header('content-length', target.size).send(body);
    },
  );

  registerAssetRoutes(app, assets, layout);
  registerEventRoutes(app, feed, options.heartbeatMs);

  if (options.jobs?.start !== false) jobs.start();
  return { app, db, layout, works, assets, feed, jobs };
}
