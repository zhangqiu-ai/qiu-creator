import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useExitFade } from './motion.js';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: focus moves in on open and back to the opener on close, Tab
 * stays inside, Esc closes (but not while an input method is composing).
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 480,
  closable = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** False while a step must be finished first (e.g. a secret shown once). */
  closable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  // Leaving: the dialog and its scrim fade (fast); focus is already back where it was.
  useExitFade(scrim);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]');
    (first ?? ref.current)?.focus();
    return () => {
      opener?.focus();
    };
  }, []);

  return (
    <div ref={scrim} className="scrim">
      <div
        ref={ref}
        className="dialog dialog--small"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: width }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape' && closable) {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== 'Tab') return;
          const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
          const firstItem = items[0];
          const lastItem = items[items.length - 1];
          if (firstItem === undefined || lastItem === undefined) return;
          if (e.shiftKey && document.activeElement === firstItem) {
            e.preventDefault();
            lastItem.focus();
          } else if (!e.shiftKey && document.activeElement === lastItem) {
            e.preventDefault();
            firstItem.focus();
          }
        }}
      >
        <div className="dialog__head">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
        </div>
        <div className="dialog__body">{children}</div>
        {footer !== undefined && <div className="dialog__foot">{footer}</div>}
      </div>
    </div>
  );
}
