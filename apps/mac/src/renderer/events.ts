import type { ChangeEntity, ChangeEvent } from '@qiu-creator/contracts';
import { useEffect, useRef, useState } from 'react';
import type { EventStreamStatus, UploadItem } from '../shared/bridge.js';

/**
 * Renderer side of the shared SSE channel. The main process owns the single
 * subscription (reconnect, Last-Event-ID); pages only listen. Any page that
 * needs live data (QC-012 assets and imports, QC-011 works) uses these hooks.
 */

/** Calls `fn` once, `delayMs` after the last `trigger()`; cancel on unmount. */
export function createDebouncer(fn: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger(): void {
      clearTimeout(timer);
      timer = setTimeout(fn, delayMs);
    },
    cancel(): void {
      clearTimeout(timer);
    },
  };
}

/** Subscribe to change events; the handler may change between renders without resubscribing. */
export function useChangeEvents(handler: (event: ChangeEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) return;
    return bridge.onEvent((event) => {
      ref.current(event);
    });
  }, []);
}

export function useEventStatus(): EventStreamStatus | null {
  const [status, setStatus] = useState<EventStreamStatus | null>(null);
  useEffect(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) return;
    let alive = true;
    const off = bridge.onEventStatus(setStatus);
    void bridge.eventStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

/**
 * Re-run `refresh` (debounced) whenever an event for one of `entities`
 * arrives, and once more whenever the stream reopens after a drop, in case
 * events were missed while the service was away.
 */
export function useRefreshOn(
  entities: readonly ChangeEntity[],
  refresh: () => void,
  delayMs = 200,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const key = entities.join(',');
  useEffect(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) return;
    const wanted = new Set(key.split(','));
    const debouncer = createDebouncer(() => {
      refreshRef.current();
    }, delayMs);
    let previous: EventStreamStatus | null = null;
    const offEvent = bridge.onEvent((event) => {
      if (wanted.has(event.entity)) debouncer.trigger();
    });
    const offStatus = bridge.onEventStatus((status) => {
      if (status === 'open' && previous === 'reconnecting') debouncer.trigger();
      previous = status;
    });
    return () => {
      debouncer.cancel();
      offEvent();
      offStatus();
    };
  }, [key, delayMs]);
}

/** This app session's uploads, kept current by the main process. */
export function useUploads(): UploadItem[] {
  const [items, setItems] = useState<UploadItem[]>([]);
  useEffect(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) return;
    let alive = true;
    const off = bridge.onUploads(setItems);
    void bridge.uploads().then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return items;
}
