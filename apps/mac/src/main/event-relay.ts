import type { AgentActivityEvent, ChangeEvent } from '@qiu-creator/contracts';
import type { EventStreamStatus } from '../shared/bridge.js';

/**
 * Subscribe once to the service's SSE feed from `lastEventId` and resolve
 * when the stream ends; reject on failure (see `readEventStream`).
 */
export type Subscribe = (
  handlers: {
    /** `since` is where the service starts when no Last-Event-ID was sent. */
    onOpen: (since: number | undefined) => void;
    onEvent: (event: ChangeEvent) => void;
    /** QC-097: live agent status; no sequence number, never replayed. */
    onAgentActivity?: (event: AgentActivityEvent) => void;
  },
  options: { lastEventId?: number; signal: AbortSignal },
) => Promise<void>;

export interface EventRelayOptions {
  /** Builds a subscriber for the current connection; null when the token is not available yet. */
  connect: () => Subscribe | null;
  /** Called for every event and every status change; the caller fans these out to windows. */
  onEvent: (event: ChangeEvent) => void;
  onStatus: (status: EventStreamStatus) => void;
  /** QC-097: live agent status blocks, passed straight on (they do not move `lastSeq`). */
  onAgentActivity?: (event: AgentActivityEvent) => void;
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: readonly number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10_000, 30_000] as const;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * One SSE subscription for the whole app, owned by the main process.
 *
 * - Reconnects with backoff and resumes with `Last-Event-ID`, so no event is
 *   lost across a dropped connection or a service restart.
 * - Delivers each `seq` at most once even if the service replays.
 * - Shared by every page: the renderer only listens (see `useChangeEvents`).
 */
export class EventRelay {
  private status: EventStreamStatus = 'connecting';
  private lastSeq: number | undefined;
  private controller: AbortController | null = null;
  private readonly backoff: readonly number[];
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: EventRelayOptions) {
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF;
    this.sleep = options.sleep ?? abortableSleep;
  }

  get currentStatus(): EventStreamStatus {
    return this.status;
  }

  get lastEventId(): number | undefined {
    return this.lastSeq;
  }

  start(): void {
    if (this.controller !== null) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.loop(controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** Skip the remaining backoff and reconnect now (e.g. after the user pressed 重試). */
  restart(): void {
    this.stop();
    this.start();
  }

  private setStatus(status: EventStreamStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    // Read through a function: TypeScript would otherwise narrow `aborted` to false across awaits.
    const aborted = (): boolean => signal.aborted;
    let failures = 0;
    while (!aborted()) {
      const subscribe = this.options.connect();
      if (subscribe !== null) {
        try {
          await subscribe(
            {
              onOpen: (since) => {
                failures = 0;
                if (this.lastSeq === undefined && since !== undefined) this.lastSeq = since;
                this.setStatus('open');
              },
              onEvent: (event) => {
                if (this.lastSeq !== undefined && event.seq <= this.lastSeq) return;
                this.lastSeq = event.seq;
                this.options.onEvent(event);
              },
              onAgentActivity: (event) => {
                this.options.onAgentActivity?.(event);
              },
            },
            { lastEventId: this.lastSeq, signal },
          );
        } catch {
          // fall through to reconnect
        }
      } else {
        failures = Math.max(failures, 1);
      }
      if (aborted()) return;
      this.setStatus('reconnecting');
      const delay = this.backoff[Math.min(failures, this.backoff.length - 1)] ?? 30_000;
      failures += 1;
      await this.sleep(delay, signal);
    }
  }
}
