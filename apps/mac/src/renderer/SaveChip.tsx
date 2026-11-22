import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { ChipTone } from './format.js';
import { Presence, springOf, tween } from './motion.js';
import { moves, useMotionMode } from './motion-mode.js';

/**
 * 儲存狀態 (DESIGN.md 動效): 未儲存 → 儲存中 → 已儲存 without flashing. The
 * old label and icon fade out while the new ones fade in (`fast`); the chip
 * takes its new width with a layout animation (`snappy`); its colour changes
 * in `fast`. 已儲存 does not blink or bounce. In test mode the label simply
 * changes, so a test never sees two at once.
 *
 * A save that ends within 150 ms never shows 儲存中: two cross-fades that
 * close together would leave the chip nearly empty for a moment (a flash).
 * The minimum width keeps the chip the same size between its usual labels,
 * so the words beside it do not shift.
 */
export const SAVING_SHOWS_AFTER_MS = 150;
export function SaveChip({
  tone,
  label,
  saving,
}: {
  tone: ChipTone;
  label: string;
  saving: boolean;
}) {
  const mode = useMotionMode();
  const shown = useShownSaveLabel(
    { tone, label, saving },
    mode === 'off' ? 0 : SAVING_SHOWS_AFTER_MS,
  );
  return (
    <motion.span
      layout={moves(mode)}
      transition={springOf('snappy')}
      className={`chip chip--${shown.tone} save-chip`}
      style={{ borderRadius: 999 }}
    >
      <Presence popLayout>
        <motion.span
          key={`${shown.tone}|${shown.label}`}
          className="save-chip__in"
          layout={moves(mode) ? 'position' : false}
          initial={mode === 'off' ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: tween('fast') }}
          exit={{ opacity: 0, transition: tween('fast', 'in') }}
        >
          {shown.saving && <span className="pulse" aria-hidden="true" />}
          {shown.label}
        </motion.span>
      </Presence>
    </motion.span>
  );
}

type SaveLabel = { tone: ChipTone; label: string; saving: boolean };

/** What the chip shows: 儲存中 only once saving has lasted `delayMs`; anything else at once. */
function useShownSaveLabel(next: SaveLabel, delayMs: number): SaveLabel {
  const lastSettled = useRef(next);
  const [savingVisible, setSavingVisible] = useState(false);
  if (!next.saving) lastSettled.current = next;
  useEffect(() => {
    if (!next.saving || delayMs === 0) {
      setSavingVisible(false);
      return;
    }
    const timer = setTimeout(() => {
      setSavingVisible(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [next.saving, delayMs]);
  if (!next.saving || delayMs === 0 || savingVisible) return next;
  return lastSettled.current;
}
