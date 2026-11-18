import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Session {
  id: string;
  size: number;
  mimeType: string;
  bytes: Buffer[];
  received: number;
  finalized: boolean;
}

interface RemoteFile {
  name: string;
  uri: string;
  mimeType: string;
  bytes: Buffer;
  polls: number;
  deleted: boolean;
  /** ISO time Google would delete the file; 48 hours after upload by default. */
  expirationTime: string;
  /** Answer FAILED from now on, whatever the polls say. */
  failed: boolean;
}

export interface GenerateReply {
  status?: number;
  body?: unknown;
}

/**
 * A local stand-in for the Gemini Files API and `generateContent` with video
 * (QC-023). Never forwards anything. Knobs:
 * - `dropChunks`: chunk request numbers (1-based) whose connection is cut after
 *   keeping half of the bytes, as if the network dropped mid-upload;
 * - `supportsQuery`: whether the resumable `query` command is answered;
 * - `processingPolls` / `failProcessing`: how a file leaves PROCESSING;
 * - `generateReplies`: scripted `generateContent` replies (FIFO);
 * - `expire` / `fail` / `vanish`: change a stored file as Google might between runs.
 */
export class FakeGeminiVideo {
  readonly starts: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  readonly chunks: { offset: number; command: string; length: number }[] = [];
  readonly queries: number[] = [];
  readonly generates: Record<string, unknown>[] = [];
  readonly deletes: string[] = [];
  readonly files = new Map<string, RemoteFile>();
  dropChunks = new Set<number>();
  supportsQuery = true;
  processingPolls = 1;
  failProcessing = false;
  readonly generateReplies: GenerateReply[] = [];
  private sessions = new Map<string, Session>();
  private chunkCount = 0;
  private server: http.Server | undefined;
  private port = 0;
  private nextId = 1;

  baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  private file(name: string): RemoteFile {
    const file = this.files.get(name);
    if (file === undefined) throw new Error(`no fake file ${name}`);
    return file;
  }

  /** Make Google say the file is deleted at `at`. */
  expire(name: string, at: Date): void {
    this.file(name).expirationTime = at.toISOString();
  }

  /** Make the file's processing fail from now on. */
  fail(name: string): void {
    this.file(name).failed = true;
  }

  /** Remove the file on Google's side (as after 48 hours), not through our DELETE. */
  vanish(name: string): void {
    this.file(name).deleted = true;
  }

  /** Bytes of the last finalized upload. */
  lastUpload(): Buffer | undefined {
    return [...this.files.values()].pop()?.bytes;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        this.handle(req, res, Buffer.concat(parts));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private json(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const url = req.url ?? '';
    const command = String(req.headers['x-goog-upload-command'] ?? '');
    if (req.method === 'POST' && url === '/upload/v1/files' && command === 'start') {
      this.starts.push({ headers: req.headers, body: body.toString('utf8') });
      const id = String(this.nextId++);
      this.sessions.set(id, {
        id,
        size: Number(req.headers['x-goog-upload-header-content-length']),
        mimeType: String(req.headers['x-goog-upload-header-content-type']),
        bytes: [],
        received: 0,
        finalized: false,
      });
      this.json(res, 200, {}, { 'x-goog-upload-url': `${this.baseUrl()}/resumable/${id}` });
      return;
    }
    const session = /^\/resumable\/(\d+)$/.exec(url)?.[1];
    if (req.method === 'POST' && session !== undefined) {
      const s = this.sessions.get(session);
      if (s === undefined) {
        this.json(res, 404, { error: { code: 404, message: 'no such upload' } });
        return;
      }
      if (command === 'query') {
        this.queries.push(s.received);
        if (!this.supportsQuery) {
          this.json(res, 400, { error: { code: 400, message: 'query not supported' } });
          return;
        }
        this.json(
          res,
          200,
          {},
          {
            'x-goog-upload-status': s.finalized ? 'final' : 'active',
            'x-goog-upload-size-received': String(s.received),
          },
        );
        return;
      }
      const offset = Number(req.headers['x-goog-upload-offset']);
      this.chunks.push({ offset, command, length: body.length });
      this.chunkCount++;
      if (offset !== s.received) {
        this.json(res, 400, {
          error: { code: 400, message: `offset ${String(offset)} != ${String(s.received)}` },
        });
        return;
      }
      if (this.dropChunks.has(this.chunkCount)) {
        const kept = body.subarray(0, Math.floor(body.length / 2));
        s.bytes.push(kept);
        s.received += kept.length;
        req.socket.destroy();
        return;
      }
      s.bytes.push(body);
      s.received += body.length;
      if (command.includes('finalize')) {
        s.finalized = true;
        const n = String(this.nextId++);
        const file: RemoteFile = {
          name: `files/f${n}`,
          uri: `${this.baseUrl()}/v1/files/f${n}`,
          mimeType: s.mimeType,
          bytes: Buffer.concat(s.bytes),
          polls: 0,
          deleted: false,
          expirationTime: new Date(Date.now() + 48 * 3600_000).toISOString(),
          failed: false,
        };
        this.files.set(file.name, file);
        this.json(
          res,
          200,
          {
            file: {
              name: file.name,
              uri: file.uri,
              mimeType: file.mimeType,
              state: 'PROCESSING',
              expirationTime: file.expirationTime,
            },
          },
          { 'x-goog-upload-status': 'final' },
        );
        return;
      }
      this.json(res, 200, {}, { 'x-goog-upload-status': 'active' });
      return;
    }
    const fileName = /^\/v1(?:beta)?\/(files\/[^/?]+)/.exec(url)?.[1];
    if (fileName !== undefined && (req.method === 'GET' || req.method === 'DELETE')) {
      const file = this.files.get(fileName);
      if (file === undefined || file.deleted) {
        this.json(res, 404, { error: { code: 404, message: 'not found' } });
        return;
      }
      if (req.method === 'DELETE') {
        file.deleted = true;
        this.deletes.push(fileName);
        this.json(res, 200, {});
        return;
      }
      file.polls++;
      const state = file.failed
        ? 'FAILED'
        : file.polls <= this.processingPolls
          ? 'PROCESSING'
          : this.failProcessing
            ? 'FAILED'
            : 'ACTIVE';
      this.json(res, 200, {
        name: file.name,
        uri: file.uri,
        mimeType: file.mimeType,
        state,
        expirationTime: file.expirationTime,
        ...(state === 'FAILED' ? { error: { code: 3, message: 'Video codec not supported' } } : {}),
      });
      return;
    }
    if (req.method === 'POST' && /^\/v1(beta)?\/models\/[^/]+:generateContent/.test(url)) {
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      this.generates.push(parsed);
      const reply = this.generateReplies.shift();
      this.json(res, reply?.status ?? 200, reply?.body ?? videoResult({}));
      return;
    }
    this.json(res, 404, { error: { code: 404, message: `unhandled ${req.method ?? ''} ${url}` } });
  }
}

/** A `generateContent` success body whose text is the video result JSON. */
export function videoResult(overrides: Record<string, unknown>): unknown {
  const result = {
    summary: '京都嵐山竹林的清晨散步，人很少，最後到渡月橋。',
    key_moments: [
      { time_seconds: 25, label: '渡月橋', description: '鏡頭轉到渡月橋。' },
      { time_seconds: 3, label: '竹林入口', description: '從竹林步道入口出發。' },
      { time_seconds: 95, label: '超出長度', description: '模型給了超過片長的時間點。' },
    ],
    title_suggestions: ['清晨的嵐山竹林', '清晨的嵐山竹林', ' 京都人少的時段 '],
    description_suggestions: ['早上七點前的竹林幾乎沒有人。'],
    cover_suggestions: [{ time_seconds: 12, reason: '竹林中央，光線最好。' }],
    ...overrides,
  };
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: JSON.stringify(result) }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 9200, candidatesTokenCount: 400, totalTokenCount: 9600 },
    modelVersion: 'gemini-3.8-flash',
  };
}
