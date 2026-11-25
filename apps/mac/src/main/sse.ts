import {
  AGENT_ACTIVITY_EVENT,
  AgentActivityEventSchema,
  ChangeEventSchema,
  EVENTS_PATH,
  type AgentActivityEvent,
  type ChangeEvent,
} from '@qiu-creator/contracts';

export interface SseHandlers {
  /** The stream is open; `since` is the service's starting sequence from its `: connected` comment. */
  onOpen: (since: number | undefined) => void;
  onEvent: (event: ChangeEvent) => void;
  /**
   * QC-097: an `event: agent.activity` block (QC-096). It has no id and is
   * never replayed: after a reconnect the renderer reads the current state.
   */
  onAgentActivity?: (event: AgentActivityEvent) => void;
}

export interface SseOptions {
  baseUrl: string;
  token: string;
  lastEventId?: number;
  signal: AbortSignal;
  /** Treat the stream as dead after this long without any bytes (the service pings every 15s). */
  idleTimeoutMs?: number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export class SseHttpError extends Error {
  constructor(readonly status: number) {
    super(`event stream HTTP ${status}`);
    this.name = 'SseHttpError';
  }
}

/**
 * Parse complete SSE blocks out of `buffer`. Comments are returned too so the
 * caller can read the service's `: connected seq=N` line.
 */
export function parseSse(buffer: string): {
  blocks: { id?: string; event?: string; data: string; comments: string[] }[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  const blocks = parts.map((part) => {
    const block: { id?: string; event?: string; data: string; comments: string[] } = {
      data: '',
      comments: [],
    };
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith(':')) {
        block.comments.push(line.slice(1).trim());
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'id') block.id = value;
      else if (field === 'event') block.event = value;
    }
    block.data = data.join('\n');
    return block;
  });
  return { blocks, rest };
}

/** One SSE connection; resolves when the service closes it, rejects on errors or idle timeout. */
export async function readEventStream(options: SseOptions, handlers: SseHandlers): Promise<void> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const idleMs = options.idleTimeoutMs ?? 45_000;
  const outerAborted = (): boolean => options.signal.aborted;
  const local = new AbortController();
  const onAbort = (): void => {
    local.abort();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const state = { timedOut: false };
  const touch = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      state.timedOut = true;
      local.abort();
    }, idleMs);
  };

  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'text/event-stream',
    };
    if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
    touch();
    const res = await doFetch(`${options.baseUrl}${EVENTS_PATH}`, {
      headers,
      signal: local.signal,
      redirect: 'error',
    });
    if (!res.ok || res.body === null) throw new SseHttpError(res.status);
    const reader = res.body.getReader();
    // Unblock a pending read() when we give up on the stream (idle timeout or stop).
    local.signal.addEventListener(
      'abort',
      () => {
        reader.cancel().catch(() => undefined);
      },
      { once: true },
    );
    const decoder = new TextDecoder();
    let buffer = '';
    let opened = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (state.timedOut && !outerAborted()) throw new Error('event stream idle timeout');
        return;
      }
      touch();
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) {
        if (!opened) {
          opened = true;
          const connected = block.comments
            .map((c) => /^connected seq=(\d+)$/.exec(c))
            .find((m) => m !== null);
          handlers.onOpen(connected?.[1] === undefined ? undefined : Number(connected[1]));
        }
        if (block.data === '') continue;
        if (block.event === AGENT_ACTIVITY_EVENT) {
          const activity = AgentActivityEventSchema.safeParse(safeJson(block.data));
          if (activity.success) handlers.onAgentActivity?.(activity.data);
          continue;
        }
        const event = ChangeEventSchema.safeParse(safeJson(block.data));
        // Unknown actions from a newer service are ignored, not fatal.
        if (event.success) handlers.onEvent(event.data);
      }
    }
  } catch (err) {
    if (outerAborted()) return;
    if (state.timedOut) throw new Error('event stream idle timeout', { cause: err });
    throw err;
  } finally {
    clearTimeout(idleTimer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
