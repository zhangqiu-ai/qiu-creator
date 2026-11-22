import { useEffect, useRef } from 'react';
import { t } from './i18n.js';

/**
 * The end of a paged list (QC-067): when it comes within a screen of view the
 * next page loads, so scrolling simply continues. While a page is on its way
 * a quiet line says so; if loading failed it offers 重試.
 */
export function LoadMore({
  hasMore,
  loading,
  failed,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  const armed = hasMore && !loading && !failed;
  useEffect(() => {
    const el = ref.current;
    if (el === null || !armed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMoreRef.current();
      },
      // Start the next page about a screen before the end shows.
      { rootMargin: '0px 0px 600px 0px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [armed]);
  if (!hasMore && !failed) return null;
  return (
    <div ref={ref} className="load-more" data-load-more>
      {failed ? (
        <button type="button" className="btn btn--small" onClick={onMore}>
          {t('common.retry')}
        </button>
      ) : (
        <span className="faint" aria-live="polite">
          {loading ? t('common.loading') : ''}
        </span>
      )}
    </div>
  );
}
