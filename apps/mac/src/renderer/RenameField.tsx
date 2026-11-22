import { useEffect, useRef, useState } from 'react';
import { renameKey, renameTitle } from './library-select.js';

/**
 * In-place rename (QC-052) for a card title, a list row or a tab: ↩ or
 * leaving the field saves, esc puts the old name back, and ↩ while the IME is
 * still composing only picks the candidate. A blank or unchanged name sends
 * nothing.
 */
export function RenameField({
  value,
  label,
  className,
  onCommit,
  onCancel,
}: {
  value: string;
  /** Accessible name, e.g. 重新命名「…」. */
  label: string;
  className?: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  /** Set once the field has answered, so blur after ↩ or esc does not answer twice. */
  const done = useRef(false);
  /** Also tracked by composition events, for input methods that end composing before keydown. */
  const composing = useRef(false);
  useEffect(() => {
    const el = input.current;
    if (el === null) return;
    el.focus();
    el.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = commit ? renameTitle(value, text) : null;
    if (title === null) onCancel();
    else onCommit(title);
  };
  return (
    <input
      ref={input}
      className={['rename', className].filter(Boolean).join(' ')}
      aria-label={label}
      value={text}
      maxLength={500}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(e) => {
        // Keys typed here never reach the card, the row, the tab bar or global shortcuts.
        e.stopPropagation();
        const action = renameKey({
          key: e.key,
          isComposing: e.nativeEvent.isComposing || composing.current,
        });
        if (action === null) return;
        e.preventDefault();
        finish(action === 'commit');
      }}
      onBlur={() => {
        finish(true);
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
      }}
    />
  );
}
