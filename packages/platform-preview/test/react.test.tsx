// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { buildPreviewModel, PLATFORMS } from '../src/index.js';
import { PlatformPreview } from '../src/react/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode): HTMLElement {
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => {
    root.render(node);
  });
  return el;
}

describe('PlatformPreview', () => {
  it('labels every platform as 模擬, names it in text, and shows the cut title', () => {
    for (const platform of PLATFORMS) {
      const el = render(
        <PlatformPreview
          model={buildPreviewModel({
            platform,
            title: '一'.repeat(70),
            body: '正文',
            tags: ['京都'],
            coverUrl: null,
            imageUrls: [],
          })}
        />,
      );
      expect(el.querySelector('.pp-sim')?.textContent).toBe('模擬');
      const label = el.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';
      expect(label).toContain('模擬預覽');
      expect(el.textContent).toContain('…');
      // No external images or logos: only the cover slot, empty here.
      expect(el.querySelectorAll('img')).toHaveLength(0);
    }
  });

  it('shows an empty state without a variant', () => {
    const el = render(<PlatformPreview model={null} empty="尚無版本" />);
    expect(el.querySelector('.pp-empty')?.textContent).toBe('尚無版本');
  });
});
