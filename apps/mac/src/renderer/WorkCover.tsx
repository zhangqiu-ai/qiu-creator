import type { WorkListItem } from '@qiu-creator/contracts';
import { useEffect, useState } from 'react';
import { formatDuration, WORK_TYPE } from './format.js';
import { t } from './i18n.js';
import { Highlight, HitPassage } from './Highlight.js';
import { Icon } from './Icon.js';

/**
 * The card's picture (PT-20261121-001, QC-061): the image the service picked
 * (cover, first image, first Markdown image or a video frame), loaded lazily
 * through its signed URL; never a `<video>` in the list. Without an image an
 * article shows a text preview, anything else its type icon — also when the
 * image fails to load, so a card is never blank.
 */
export function CardCover({
  work,
  imageUrl,
  onNeedsFrame,
}: {
  work: WorkListItem;
  /** Server-relative URL → absolute (`client.media.absoluteUrl`). */
  imageUrl: (relative: string) => string;
  /** A video card whose frame the service could not take: the App grabs it off-screen. */
  onNeedsFrame?: (work: WorkListItem) => void;
}) {
  const card = work.card_image ?? null;
  const url = card?.url ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  const needsFrame = card?.needs_frame === true;
  useEffect(() => {
    if (needsFrame) onNeedsFrame?.(work);
  }, [needsFrame, onNeedsFrame, work]);
  const showImage = url !== null && failed !== url;
  const excerpt = work.excerpt ?? null;
  /** A search hit only in the text (QC-068): a text card shows the passage on its cover. */
  const hit = work.match_excerpt ?? null;
  return (
    <span
      className={showImage ? 'wcard__cover' : 'wcard__cover wcard__cover--empty'}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className="wcard__media"
          src={imageUrl(url)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => {
            setFailed(url);
          }}
        />
      ) : work.type === 'article' && (hit ?? excerpt) !== null ? (
        <span className="wcard__text">
          <span className="wcard__text-body">
            {hit !== null ? <HitPassage text={hit} /> : <Highlight text={excerpt ?? ''} long />}
          </span>
        </span>
      ) : (
        <Icon name={WORK_TYPE[work.type].icon} size={28} />
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
