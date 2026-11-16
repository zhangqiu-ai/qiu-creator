import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AssetIdParamsSchema,
  AssetRecordSchema,
  DIRECT_UPLOAD_MAX_BYTES,
  DirectUploadQuerySchema,
  ErrorResponseSchema,
  LinkWorkAssetRequestSchema,
  ListAssetsQuerySchema,
  ListAssetsResponseSchema,
  ReorderWorkAssetsRequestSchema,
  TUS_UPLOAD_PATH,
  UploadAssetResponseSchema,
  WorkAssetListResponseSchema,
  WorkAssetParamsSchema,
  WorkAssetRoleQuerySchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { FileStore } from '@tus/file-store';
import { Server as TusServer } from '@tus/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AssetService } from '../assets/asset-service.js';
import { ServiceError } from '../errors.js';
import { errorBody, type App } from '../http/app-type.js';
import type { Layout } from '../layout.js';
import { THUMBNAIL_MIME } from '../media/thumbnails.js';
import { maxUploadBytes } from '../media/detect.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

class PayloadTooLarge extends Error {}

/**
 * FileStore's constructor creates its directory with an async mkdir whose
 * callback throws, i.e. an uncaught exception that kills the process if the
 * directory disappears mid-call. `Layout.ensureBase()` already created it, so
 * do the check synchronously instead. The method is `private` in the typings,
 * hence the base re-typed without it; if a future version renames the method
 * this override is simply unused and the library default applies.
 */
type FileStoreOptions = ConstructorParameters<typeof FileStore>[0];
const FileStoreBase: new (options: FileStoreOptions) => Pick<FileStore, keyof FileStore> =
  FileStore;
class UploadFileStore extends FileStoreBase {
  checkOrCreateDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
}

/** tus maps a thrown error carrying `status_code` and `body` to the HTTP response. */
class TusHookError extends Error {
  constructor(
    readonly status_code: number,
    readonly body: string,
  ) {
    super(body);
  }
}

/** Count bytes through a stream and abort once `limit` is exceeded. */
function byteLimit(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) cb(new PayloadTooLarge());
      else cb(null, chunk);
    },
  });
}

export function registerAssetRoutes(app: App, assets: AssetService, layout: Layout): void {
  const directLimit = Math.min(DIRECT_UPLOAD_MAX_BYTES, maxUploadBytes(assets.limits));

  // Raw bodies for uploads: hand the stream to the route instead of buffering it.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  // tus PATCH bodies are consumed by the tus server itself.
  app.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => {
    done(null);
  });

  app.post(
    '/api/v1/assets/uploads',
    {
      schema: {
        description: `Single-request upload (Content-Type: application/octet-stream, up to ${DIRECT_UPLOAD_MAX_BYTES} bytes). Larger files must use the tus 1.0.0 resumable endpoint at ${TUS_UPLOAD_PATH} (Upload-Metadata: filename <base64>). Type is decided by magic bytes; identical content returns the existing asset with deduplicated=true.`,
        querystring: DirectUploadQuerySchema,
        response: {
          200: UploadAssetResponseSchema,
          201: UploadAssetResponseSchema,
          413: ErrorResponseSchema,
          415: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      if (!(req.body instanceof Readable)) {
        throw new ServiceError(
          415,
          'unsupported_media_type',
          'send the file as application/octet-stream',
        );
      }
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > directLimit) {
        req.body.resume();
        throw new ServiceError(
          413,
          'payload_too_large',
          `direct uploads are limited to ${directLimit} bytes; use ${TUS_UPLOAD_PATH}`,
        );
      }
      const temp = path.join(layout.incomingDir, `${randomUUID()}.part`);
      try {
        await pipeline(
          req.body,
          byteLimit(directLimit),
          fs.createWriteStream(temp, { flags: 'wx' }),
        );
      } catch (err) {
        fs.rmSync(temp, { force: true });
        if (err instanceof PayloadTooLarge) {
          throw new ServiceError(
            413,
            'payload_too_large',
            `direct uploads are limited to ${directLimit} bytes; use ${TUS_UPLOAD_PATH}`,
          );
        }
        throw err;
      }
      const result = await assets.ingest(temp, req.query.filename, 'upload');
      reply.code(result.deduplicated ? 200 : 201);
      return result;
    },
  );

  // ---- tus resumable uploads --------------------------------------------------
  // Built on first use: FileStore touches the upload directory asynchronously
  // when constructed, which should not happen for servers that never see a tus request.
  let tusServer: TusServer | undefined;
  const createTus = (): TusServer => {
    return new TusServer({
      path: TUS_UPLOAD_PATH,
      relativeLocation: true,
      maxSize: maxUploadBytes(assets.limits),
      datastore: new UploadFileStore({
        directory: layout.uploadsDir,
        expirationPeriodInMilliseconds: 7 * 24 * 60 * 60 * 1000,
      }),
      onUploadFinish: async (_req, upload) => {
        const file = path.join(layout.uploadsDir, upload.id);
        const name = upload.metadata?.['filename'] ?? 'upload';
        try {
          const result = await assets.ingest(file, name, 'upload');
          return {
            status_code: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(UploadAssetResponseSchema.parse(result)),
          };
        } catch (err) {
          if (err instanceof ServiceError) {
            throw new TusHookError(
              err.statusCode,
              JSON.stringify(errorBody(err.code, err.message)),
            );
          }
          throw err;
        } finally {
          fs.rmSync(`${file}.json`, { force: true });
        }
      },
    });
  };

  const tusHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    tusServer ??= createTus();
    await tusServer.handle(req.raw, reply.raw);
  };
  app.all(TUS_UPLOAD_PATH, { schema: { hide: true } }, tusHandler);
  app.all(`${TUS_UPLOAD_PATH}/*`, { schema: { hide: true } }, tusHandler);

  // ---- Asset library -------------------------------------------------------------
  app.get(
    '/api/v1/assets',
    {
      schema: {
        querystring: ListAssetsQuerySchema,
        response: { 200: ListAssetsResponseSchema, ...errorResponses },
      },
    },
    (req) => assets.list(req.query),
  );

  app.get(
    '/api/v1/assets/:id',
    {
      schema: {
        params: AssetIdParamsSchema,
        response: { 200: AssetRecordSchema, ...errorResponses },
      },
    },
    (req) => assets.get(req.params.id),
  );

  app.get(
    '/api/v1/assets/:id/thumbnail',
    {
      schema: {
        description:
          'WebP thumbnail (longest edge 512px) for image assets; regenerated on demand if the cache was cleared.',
        params: AssetIdParamsSchema,
      },
    },
    async (req, reply) => {
      const file = await assets.thumbnailFile(req.params.id);
      const stat = fs.statSync(file);
      return reply
        .header('content-type', THUMBNAIL_MIME)
        .header('content-length', stat.size)
        .header('cache-control', 'private, max-age=300')
        .send(fs.readFileSync(file));
    },
  );

  // ---- Work ↔ asset links --------------------------------------------------------
  app.get(
    '/api/v1/works/:id/assets',
    {
      schema: {
        params: WorkIdParamsSchema,
        response: { 200: WorkAssetListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: assets.workAssets(req.params.id) }),
  );

  app.post(
    '/api/v1/works/:id/assets',
    {
      schema: {
        description:
          'Link an asset to a work as cover, body or video. Linking an existing pair moves it to `position`.',
        params: WorkIdParamsSchema,
        body: LinkWorkAssetRequestSchema,
        response: { 200: WorkAssetListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({
      items: assets.link(req.params.id, req.body.asset_id, req.body.role, req.body.position),
    }),
  );

  app.delete(
    '/api/v1/works/:id/assets/:assetId',
    {
      schema: {
        params: WorkAssetParamsSchema,
        querystring: WorkAssetRoleQuerySchema,
        response: { 200: WorkAssetListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: assets.unlink(req.params.id, req.params.assetId, req.query.role) }),
  );

  app.put(
    '/api/v1/works/:id/assets/order',
    {
      schema: {
        params: WorkIdParamsSchema,
        body: ReorderWorkAssetsRequestSchema,
        response: { 200: WorkAssetListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: assets.reorder(req.params.id, req.body.role, req.body.asset_ids) }),
  );
}
