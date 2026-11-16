/** Minimal inline SVG icons (placeholder until the icon set is approved). */
export type IconName = 'plus' | 'history' | 'close';

const PATHS: Readonly<Record<IconName, string>> = {
  plus: 'M8 3v10M3 8h10',
  history: 'M8 4.5V8l2.5 1.5M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6',
  close: 'M4 4l8 8M12 4l-8 8',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
