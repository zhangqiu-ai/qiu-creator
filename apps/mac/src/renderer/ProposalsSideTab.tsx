import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { ProposalDetail, ProposalSummary } from '@qiu-creator/contracts';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { useChangeEvents } from './events.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { hunkPlace, isProposalEvent, type ProposalCountsStore } from './proposals.js';
import { ProposalView, type Notice } from './ProposalView.js';
import './proposals.css';

/** The app's pending-proposal counts (sidebar badge, editor tab); null outside the app. */
export const ProposalCountsContext = createContext<ProposalCountsStore | null>(null);

/** Pending proposals for one work (0 without the app's store). */
export function usePendingFor(workId: string): number {
  const store = useContext(ProposalCountsContext);
  const counts = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.getSnapshot().byWork[workId] ?? 0,
  );
  return counts;
}

const noSubscribe = (): (() => void) => () => undefined;

export type TextRange = { start: number; end: number };

/**
 * The editor sidebar's 提案 tab (QC-091, PT-20261124-001): the work's
 * pending proposals one at a time, decided in place. The changes are
 * highlighted in the text on the left (`onHighlight`).
 */
export function ProposalsSideTab({
  client,
  workId,
  text,
  prepare,
  onHighlight,
  onNotice,
}: {
  client: CreatorHubClient;
  workId: string;
  /** The text shown on the left, to find where each change sits. */
  text: string;
  /** Save the editor first; the revision to accept on, or null when it could not be saved. */
  prepare: () => Promise<string | null>;
  onHighlight: (ranges: readonly TextRange[]) => void;
  onNotice: Notice;
}) {
  const [items, setItems] = useState<ProposalSummary[]>([]);
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    client.proposals
      .list({ status: 'pending', work_id: workId })
      .then((r) => {
        if (alive) setItems(r.items);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, workId, epoch]);
  useChangeEvents((event) => {
    if (event.entity === 'work' && event.entity_id === workId && isProposalEvent(event.action)) {
      setEpoch((n) => n + 1);
    }
    // The work moved on: overlaps may have changed.
    if (event.entity === 'work' && event.entity_id === workId && event.action === 'work.updated') {
      setEpoch((n) => n + 1);
    }
  });

  const at = Math.min(index, Math.max(0, items.length - 1));
  const current = items[at] ?? null;
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (currentId === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    client.proposals
      .get(currentId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, currentId, epoch]);

  // Highlight where the pending changes sit in the text on the left.
  useEffect(() => {
    if (detail === null || detail.status !== 'pending') {
      onHighlight([]);
      return;
    }
    const ranges: TextRange[] = [];
    for (const h of detail.hunks) {
      const place = hunkPlace(text, detail.base_markdown, h);
      if (place !== null) ranges.push(place);
    }
    onHighlight(ranges);
  }, [detail, text, onHighlight]);
  useEffect(
    () => () => {
      onHighlight([]);
    },
    [onHighlight],
  );

  if (detail === null) {
    return (
      <div className="pr-side">
        <div className="pr-empty">
          <Icon name="agentInbox" size={24} />
          <span className="faint">{t('agents.sideNone')}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="pr-side">
      {items.length > 1 && (
        <div className="pr-side__nav">
          <span className="faint">{t('agents.sideMore', { count: items.length - 1 })}</span>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small"
            aria-label={t('agents.prevProposal')}
            disabled={at === 0}
            onClick={() => {
              setIndex(at - 1);
            }}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="num faint">{`${String(at + 1)} / ${String(items.length)}`}</span>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small"
            aria-label={t('agents.nextProposal')}
            disabled={at >= items.length - 1}
            onClick={() => {
              setIndex(at + 1);
            }}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
      )}
      <ProposalView
        key={detail.id}
        client={client}
        detail={detail}
        compact
        prepare={prepare}
        onChanged={(next) => {
          setDetail(next);
          setEpoch((n) => n + 1);
        }}
        onNotice={onNotice}
      />
    </div>
  );
}
