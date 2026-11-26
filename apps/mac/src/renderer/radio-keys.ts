import type { KeyboardEvent } from 'react';

/**
 * Arrow keys in a row of `role="radio"` buttons (a segmented control): pick
 * the previous or next option, wrapping, and move focus with it.
 */
export function radioKeys<T>(
  e: KeyboardEvent<HTMLButtonElement>,
  options: readonly T[],
  index: number,
  pick: (value: T) => void,
): void {
  const step =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) return;
  e.preventDefault();
  const at = (index + step + options.length) % options.length;
  const next = options[at];
  if (next === undefined) return;
  pick(next);
  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[at]?.focus();
}
