import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake provider saw: never forwarded anywhere. */
export interface SeenRequest {
  provider: 'anthropic' | 'openai' | 'gemini' | 'new-api';
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A scripted reply. `delayMs` holds the response (for timeouts and cancellation). */
export interface FakeReply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

type Provider = SeenRequest['provider'];

/** Default success bodies in each provider's wire format. */
export function ok(provider: Provider, text: string, model = 'served-model'): FakeReply {
  switch (provider) {
    case 'anthropic':
      return {
        body: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 300 },
        },
      };
    case 'openai':
      return {
        body: {
          id: 'resp_fake',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model,
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ],
          incomplete_details: null,
          usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
        },
      };
    case 'new-api':
      return {
        body: {
          id: 'chatcmpl_fake',
          object: 'chat.completion',
          created: 1,
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
        },
      };
    case 'gemini':
      return {
        body: {
          candidates: [
            { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 },
          ],
          usageMetadata: {
            promptTokenCount: 1200,
            candidatesTokenCount: 250,
            thoughtsTokenCount: 50,
            totalTokenCount: 1500,
          },
          modelVersion: model,
        },
      };
  }
}

/** Provider-style error bodies. */
export function fail(provider: Provider, status: number, message = 'nope'): FakeReply {
  switch (provider) {
    case 'anthropic':
      return {
        status,
        body: {
          type: 'error',
          error: {
            type:
              status === 429
                ? 'rate_limit_error'
                : status === 529
                  ? 'overloaded_error'
                  : 'invalid_request_error',
            message,
          },
        },
      };
    case 'openai':
    case 'new-api':
      return { status, body: { error: { message, type: 'invalid_request_error', code: null } } };
    case 'gemini':
      return { status, body: { error: { code: status, message, status: 'INVALID_ARGUMENT' } } };
  }
}

/**
 * One local HTTP server answering like Anthropic (`POST /v1/messages`),
 * OpenAI (`POST /v1/responses`) and Gemini (`POST /v1[beta]/models/<m>:generateContent`; `@google/genai` 3.x uses `/v1`).
 * Replies are scripted per provider (FIFO, falling back to a default success).
 */
export class FakeAiServer {
  readonly seen: SeenRequest[] = [];
  /** Requests whose client went away before the reply (aborts). */
  readonly aborted: SeenRequest[] = [];
  private readonly queues: Record<Provider, FakeReply[]> = {
    anthropic: [],
    openai: [],
    gemini: [],
    'new-api': [],
  };
  private server: http.Server | undefined;
  private port = 0;
  /**
   * New API's `GET /v1/models` (QC-054 model list): null answers 404, as
   * before the list existed. `modelRequests` counts how often it was asked.
   */
  modelsReply: FakeReply | null = null;
  modelRequests = 0;
  /**
   * New API's `POST /v1/images/generations` (QC-070): scripted replies, FIFO;
   * without one the relay answers 500. `imageRequests` holds the bodies sent.
   */
  readonly imageReplies: FakeReply[] = [];
  readonly imageRequests: Record<string, unknown>[] = [];

  script(provider: Provider, ...replies: FakeReply[]): void {
    this.queues[provider].push(...replies);
  }

  for(provider: Provider): SeenRequest[] {
    return this.seen.filter((r) => r.provider === provider);
  }

  baseUrls(): Record<Provider, string> {
    const origin = `http://127.0.0.1:${String(this.port)}`;
    return { anthropic: origin, openai: `${origin}/v1`, gemini: origin, 'new-api': `${origin}/v1` };
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '';
        if (req.method === 'GET' && path === '/v1/models') {
          this.modelRequests += 1;
          const reply = this.modelsReply;
          if (reply === null) {
            res.writeHead(404).end();
            return;
          }
          // `delayMs` holds the list as for every other reply (QC-081): 測試連線's
          // running state and 取消 are only observable while the answer is pending.
          const send = (): void => {
            if (res.destroyed) return;
            res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(reply.body));
          };
          if (reply.delayMs === undefined) send();
          else setTimeout(send, reply.delayMs).unref();
          return;
        }
        if (req.method === 'POST' && path === '/v1/images/generations') {
          const raw = Buffer.concat(chunks).toString('utf8');
          this.imageRequests.push(raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>));
          const reply = this.imageReplies.shift() ?? {
            status: 500,
            body: { error: { message: 'no scripted image' } },
          };
          const send = (): void => {
            if (res.destroyed) return;
            res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(reply.body ?? {}));
          };
          if (reply.delayMs === undefined) send();
          else setTimeout(send, reply.delayMs).unref();
          return;
        }
        const provider: Provider | undefined = path.startsWith('/v1/messages')
          ? 'anthropic'
          : path.startsWith('/v1/responses')
            ? 'openai'
            : path === '/v1/chat/completions'
              ? 'new-api'
              : /^\/v1(beta)?\/models\/[^/]+:generateContent/.test(path)
                ? 'gemini'
                : undefined;
        if (provider === undefined) {
          res.writeHead(404).end();
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const seen: SeenRequest = {
          provider,
          method: req.method ?? '',
          path,
          headers: req.headers,
          body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
        };
        this.seen.push(seen);
        const reply = this.queues[provider].shift() ?? ok(provider, 'default reply');
        const send = (): void => {
          // Only the response side tells whether the client is still there: Node
          // marks a fully read request `destroyed` (autoDestroy) right away.
          if (res.destroyed) return;
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body ?? {}));
        };
        res.on('close', () => {
          if (!res.writableEnded) this.aborted.push(seen);
        });
        if (reply.delayMs === undefined) send();
        else setTimeout(send, reply.delayMs).unref();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
