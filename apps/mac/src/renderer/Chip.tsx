import type { ReactNode } from 'react';
import type { ChipTone } from './format.js';

export function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}
