import type { WorkListItem } from '@qiu-creator/contracts';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { formatDuration, WORK_TYPE } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';

/**
 * The card's picture (PT-20261121-001): an image post shows its cover or
 * first image and how many images; a video its cover frame, length and
 * orientation; an article (no picture) its type icon.
 */
export function CardCover({ work }: { work: WorkListItem }) {
  const thumb = work.thumbnail ?? null;
  const assetId = thumb?.asset_id ?? null;
  return (
    <span className="wcard__cover" aria-hidden="true">
      {thumb === null || assetId === null ? (
        <Icon name={WORK_TYPE[work.type].icon} size={28} />
      ) : thumb.kind === 'video' ? (
        <video
          className="wcard__media"
          src={`${assetMediaUrl(assetId)}#t=${String(thumb.time_seconds ?? 0.1)}`}
          muted
          preload="metadata"
        />
      ) : (
        <img className="wcard__media" src={thumbnailUrl(assetId)} alt="" loading="lazy" />
      )}
      {work.type === 'image' && work.image_count != null && work.image_count > 0 && (
        <span className="wcard__badge">
          <Icon name="image" size={12} />
          {t('library.imageCount', { count: work.image_count })}
        </span>
      )}
      {work.type === 'video' && work.duration_seconds != null && (
        <span className="wcard__badge">
          {formatDuration(work.duration_seconds)}
          {work.orientation === 'portrait'
            ? ` · ${t('library.portrait')}`
            : work.orientation === 'landscape'
              ? ` · ${t('library.landscape')}`
              : ''}
        </span>
      )}
      {(work.missing_media ?? 0) > 0 && (
        <span className="wcard__badge wcard__badge--bad">
          <Icon name="fileMissing" size={12} />
          {t('library.mediaMissing', { count: work.missing_media ?? 0 })}
        </span>
      )}
    </span>
  );
}
