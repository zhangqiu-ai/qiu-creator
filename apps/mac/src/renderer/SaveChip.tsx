import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { SAVE_STATUS, type ChipTone } from './format.js';
import { t } from './i18n.js';
import { Presence, springOf, tween } from './motion.js';
import { useMotionMode } from './motion-mode.js';
import type { SaveStatus } from './work-session.js';

/**
 * 儲存狀態 (QC-071, DESIGN.md 動效): the chip says nothing while everything is
 * saved, so a permanent 已儲存 never reads as a promise. It shows
 *   未儲存  faintly, while there are unsaved changes;
 *   儲存中  only once a save lasts over 150 ms (a shorter save never flashes);
 *   已儲存  for about 2 s after a save completes, then fades out (`fast`);
 *   failure, conflict, read-only  for as long as they last: prominent and
 *   clickable for failure and conflict, so the user can deal with it.
 * The chip sits in a fixed-width slot (`.save-status`), so the version number
 * and word count beside it never move when it appears or goes. In test mode
 * the label simply changes, so a test never sees two at once.
 */
export const SAVING_SHOWS_AFTER_MS = 150;
export const SAVED_SHOWS_FOR_MS = 2000;

export type SaveChipKind = SaveStatus | 'readonly';

export interface SaveChipView {
  readonly tone: ChipTone;
  readonly label: string;
  readonly saving: boolean;
  /** Faint: unsaved changes are not an alarm. */
  readonly faint: boolean;
  /** A problem the user can act on: shown prominently and clickable. */
  readonly alert: boolean;
}

export interface SaveChipLabels {
  readonly saved: string;
  readonly dirty: string;
  readonly saving: string;
  readonly error: string;
  readonly conflict: string;
  readonly readonly: string;
}

/**
 * What the chip shows, or null for nothing. `justSaved` is true for the short
 * time after a save completes; `savingLong` once the save has lasted 150 ms.
 */
export function saveChipView(
  kind: SaveChipKind,
  labels: SaveChipLabels,
  flags: { justSaved: boolean; savingLong: boolean },
): SaveChipView | null {
  const base = { saving: false, faint: false, alert: false };
  switch (kind) {
    case 'saved':
      return flags.justSaved ? { ...base, tone: 'ok', label: labels.saved } : null;
    case 'dirty':
      return { ...base, tone: 'neutral', label: labels.dirty, faint: true };
    case 'saving':
      return flags.savingLong
        ? { ...base, tone: 'neutral', label: labels.saving, saving: true }
        : { ...base, tone: 'neutral', label: labels.dirty, faint: true };
    case 'error':
      return { ...base, tone: 'bad', label: labels.error, alert: true };
    case 'conflict':
      return { ...base, tone: 'bad', label: labels.conflict, alert: true };
    case 'readonly':
      return { ...base, tone: 'neutral', label: labels.readonly };
  }
}

export function SaveChip({
  status,
  readOnly,
  onAct,
}: {
  status: SaveStatus;
  readOnly: boolean;
  /** Click on a failure or conflict chip: retry, or open the conflict dialog. */
  onAct?: () => void;
}) {
  const mode = useMotionMode();
  const kind: SaveChipKind = readOnly ? 'readonly' : status;
  const labels: SaveChipLabels = {
    saved: SAVE_STATUS.saved.label,
    dirty: SAVE_STATUS.dirty.label,
    saving: SAVE_STATUS.saving.label,
    error: SAVE_STATUS.error.label,
    conflict: SAVE_STATUS.conflict.label,
    readonly: t('editor.readOnlyChip'),
  };
  const flags = useSaveFlags(kind, mode === 'off' ? 0 : SAVING_SHOWS_AFTER_MS);
  const view = saveChipView(kind, labels, flags);
  const actionable = view?.alert === true && onAct !== undefined;
  return (
    <Presence>
      {view !== null && (
        <motion.span
          key="chip"
          layout={false}
          initial={mode === 'off' ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: tween('fast') }}
          exit={{ opacity: 0, transition: tween('fast', 'in') }}
          transition={springOf('snappy')}
          className={`chip chip--${view.tone} save-chip${view.faint ? ' save-chip--faint' : ''}${
            view.alert ? ' save-chip--alert' : ''
          }`}
          style={{ borderRadius: 999 }}
          {...(actionable
            ? {
                role: 'button',
                tabIndex: 0,
                onClick: onAct,
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onAct();
                  }
                },
              }
            : {})}
        >
          <Presence popLayout>
            <motion.span
              key={`${view.tone}|${view.label}`}
              className="save-chip__in"
              initial={mode === 'off' ? false : { opacity: 0 }}
              animate={{ opacity: 1, transition: tween('fast') }}
              exit={{ opacity: 0, transition: tween('fast', 'in') }}
            >
              {view.saving && <span className="pulse" aria-hidden="true" />}
              {view.label}
            </motion.span>
          </Presence>
        </motion.span>
      )}
    </Presence>
  );
}

/** Timers behind the chip: "just saved" for 2 s, and "saving is taking long" after `delayMs`. */
function useSaveFlags(
  kind: SaveChipKind,
  delayMs: number,
): { justSaved: boolean; savingLong: boolean } {
  const [justSaved, setJustSaved] = useState(false);
  const [savingLong, setSavingLong] = useState(false);
  const previous = useRef<SaveChipKind>(kind);
  useEffect(() => {
    const was = previous.current;
    previous.current = kind;
    if (kind !== 'saved') {
      setJustSaved(false);
      return;
    }
    // Only a save that just finished says 已儲存; opening a saved work says nothing.
    if (was !== 'dirty' && was !== 'saving') return;
    setJustSaved(true);
    const timer = setTimeout(() => {
      setJustSaved(false);
    }, SAVED_SHOWS_FOR_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [kind]);
  useEffect(() => {
    if (kind !== 'saving' || delayMs === 0) {
      setSavingLong(false);
      return;
    }
    const timer = setTimeout(() => {
      setSavingLong(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [kind, delayMs]);
  return { justSaved, savingLong: kind === 'saving' && (delayMs === 0 || savingLong) };
}
