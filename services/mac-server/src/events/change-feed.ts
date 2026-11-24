import { EventEmitter } from 'node:events';
import type { ChangeAction, ChangeEntity, ChangeEvent } from '@qiu-creator/contracts';
import { currentActorId } from '../auth/actor-context.js';
import type { Db } from '../db/database.js';

interface ChangeRow {
  seq: number;
  entity: string;
  entity_id: string;
  action: string;
  data: string;
  created_at: string;
  actor: string | null;
}

function toEvent(row: ChangeRow): ChangeEvent {
  const data: unknown = JSON.parse(row.data);
  return {
    seq: row.seq,
    entity: row.entity as ChangeEntity,
    entity_id: row.entity_id,
    action: row.action as ChangeAction,
    data: typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {},
    created_at: row.created_at,
    actor: row.actor,
  };
}

/**
 * Durable change log plus in-process fan-out.
 *
 * `record()` only inserts a row, so callers can use it inside their own
 * SQLite transaction. Publishing happens on a microtask that re-reads rows
 * after the last published seq: by then the synchronous transaction has
 * either committed (rows visible, published once) or rolled back (rows gone,
 * nothing published). Subscribers never see changes that did not persist.
 */
export class ChangeFeed {
  private readonly emitter = new EventEmitter();
  private lastPublished: number;
  private flushScheduled = false;

  constructor(private readonly db: Db) {
    this.emitter.setMaxListeners(0);
    this.lastPublished = this.latestSeq();
  }

  record(
    entity: ChangeEntity,
    entityId: string,
    action: ChangeAction,
    data: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO change_log (entity, entity_id, action, data, created_at, actor)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity,
        entityId,
        action,
        JSON.stringify(data),
        new Date().toISOString(),
        // QC-089: who caused it, from the request being handled.
        currentActorId(),
      );
    this.scheduleFlush();
  }

  latestSeq(): number {
    const row = this.db
      .prepare<[], { seq: number | null }>('SELECT max(seq) AS seq FROM change_log')
      .get();
    return row?.seq ?? 0;
  }

  /** Events after `seq`, oldest first (used for `Last-Event-ID` replay). */
  since(seq: number, limit = 1000): ChangeEvent[] {
    return this.db
      .prepare<[number, number], ChangeRow>(
        'SELECT * FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?',
      )
      .all(seq, limit)
      .map(toEvent);
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.db.open) return;
    for (;;) {
      const batch = this.since(this.lastPublished);
      for (const event of batch) {
        this.lastPublished = event.seq;
        this.emitter.emit('change', event);
      }
      if (batch.length < 1000) return;
    }
  }
}
