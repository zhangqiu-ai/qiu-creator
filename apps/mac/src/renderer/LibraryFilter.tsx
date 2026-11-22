import type { WorkStatus, WorkType } from '@qiu-creator/contracts';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { WORK_STATUS, WORK_TYPE } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import type { StatusCounts, TypeCounts } from './library-counts.js';
import { ExitFade } from './motion.js';

export type TypeFilter = 'all' | WorkType;
export type StatusFilter = 'all' | WorkStatus;

export const TYPE_FILTERS: readonly TypeFilter[] = ['all', 'article', 'image', 'video'];
export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'drafting',
  'in_review',
  'ready',
  'published',
];

const typeLabel = (f: TypeFilter) => (f === 'all' ? t('library.all') : WORK_TYPE[f].label);
const statusLabel = (f: StatusFilter) => (f === 'all' ? t('library.all') : WORK_STATUS[f].label);

/**
 * 篩選 (QC-069, PT-20261122-001): type and status in one popover of two
 * single-choice groups, instead of a row of segments and a row of chips.
 * Every option shows how many works it would show (faceted: the type counts
 * follow the chosen status and the other way round, among the search
 * results); an option with none is dimmed and cannot be picked, but keeps its
 * place. While a filter is on the button takes the accent and says how many.
 */
export function FilterMenu({
  type,
  status,
  typeCounts,
  statusCounts,
  onType,
  onStatus,
}: {
  type: TypeFilter;
  status: StatusFilter;
  typeCounts: TypeCounts;
  statusCounts: StatusCounts;
  onType: (type: TypeFilter) => void;
  onStatus: (status: StatusFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const active = (type === 'all' ? 0 : 1) + (status === 'all' ? 0 : 1);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    });
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target) !== true) setOpen(false);
    };
    // Esc closes it wherever focus is (it may not have moved into the popover yet).
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  /** ↑/↓ move the choice within a group (radio keys); disabled options are skipped. */
  const groupKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const radios = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'),
    );
    const at = radios.findIndex((r) => r === document.activeElement);
    if (radios.length === 0) return;
    e.preventDefault();
    const next = radios[(at + (e.key === 'ArrowDown' ? 1 : -1) + radios.length) % radios.length];
    next?.focus();
    next?.click();
  };

  const option = <F extends string>(
    value: F,
    current: F,
    label: string,
    n: number,
    pick: (v: F) => void,
    dot?: string,
  ) => {
    const checked = value === current;
    // Nothing to show: dimmed, not hidden, so the options never jump (「全部」 always works).
    const disabled = value !== 'all' && n === 0 && !checked;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        className="fmenu__opt"
        aria-checked={checked}
        disabled={disabled}
        tabIndex={checked ? 0 : -1}
        onClick={() => {
          pick(value);
        }}
      >
        <span className="fmenu__radio" aria-hidden="true" />
        {dot !== undefined && <span className={`sdot sdot--${dot}`} aria-hidden="true" />}
        <span className="fmenu__label">{label}</span>
        <span className="fmenu__n num">{n}</span>
      </button>
    );
  };

  return (
    <div className="fmenu" ref={root}>
      <button
        ref={button}
        type="button"
        className={active > 0 ? 'btn fmenu__btn fmenu__btn--on' : 'btn fmenu__btn'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={active > 0 ? t('library.filterApplied', { count: active }) : undefined}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="filter" size={14} />
        {t('library.filter')}
        {active > 0 && (
          <span className="fmenu__badge num" aria-hidden="true">
            {active}
          </span>
        )}
      </button>
      {open && (
        <ExitFade>
          <div className="pop fmenu__pop" role="dialog" aria-label={t('library.filter')}>
            <div className="fmenu__head" id="fmenu-type">
              {t('library.type')}
            </div>
            <div role="radiogroup" aria-labelledby="fmenu-type" onKeyDown={groupKey}>
              {TYPE_FILTERS.map((f) => option(f, type, typeLabel(f), typeCounts[f], onType))}
            </div>
            <div className="pop__sep" />
            <div className="fmenu__head" id="fmenu-status">
              {t('library.status')}
            </div>
            <div role="radiogroup" aria-labelledby="fmenu-status" onKeyDown={groupKey}>
              {STATUS_FILTERS.map((f) =>
                option(
                  f,
                  status,
                  statusLabel(f),
                  statusCounts[f],
                  onStatus,
                  f === 'all' ? undefined : WORK_STATUS[f].tone,
                ),
              )}
            </div>
            {active > 0 && (
              <>
                <div className="pop__sep" />
                <button
                  type="button"
                  className="btn btn--small btn--ghost fmenu__clear"
                  onClick={() => {
                    onType('all');
                    onStatus('all');
                  }}
                >
                  {t('library.clearFilter')}
                </button>
              </>
            )}
          </div>
        </ExitFade>
      )}
    </div>
  );
}

/** The filters in use, under the header, each removable, then 清除篩選 (QC-069). */
export function ActiveFilters({
  type,
  status,
  onType,
  onStatus,
}: {
  type: TypeFilter;
  status: StatusFilter;
  onType: (type: TypeFilter) => void;
  onStatus: (status: StatusFilter) => void;
}) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (type !== 'all')
    chips.push({
      key: 'type',
      label: typeLabel(type),
      clear: () => {
        onType('all');
      },
    });
  if (status !== 'all')
    chips.push({
      key: 'status',
      label: statusLabel(status),
      clear: () => {
        onStatus('all');
      },
    });
  return (
    <div className="afilters" role="group" aria-label={t('library.activeFilters')}>
      {chips.map((c) => (
        <span key={c.key} className="afilters__chip">
          {c.label}
          <button
            type="button"
            className="afilters__x"
            aria-label={t('library.removeFilter', { name: c.label })}
            onClick={c.clear}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <button
        type="button"
        className="btn btn--small btn--ghost"
        onClick={() => {
          onType('all');
          onStatus('all');
        }}
      >
        {t('library.clearFilter')}
      </button>
    </div>
  );
}
