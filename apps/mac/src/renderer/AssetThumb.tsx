import type { AssetRecord } from '@qiu-creator/contracts';
import { useRef, useState } from 'react';
import { thumbnailUrl } from '../shared/bridge.js';
import { ASSET_KIND } from './format.js';
import { Icon } from './Icon.js';
import { useVideoThumb } from './video-thumbs.js';

/**
 * An asset's small picture: the service thumbnail of an image, a frame of a
 * video (taken by the App once the card is on screen, QC-108), else the
 * kind's icon.
 */
export function AssetThumb({ asset, size }: { asset: AssetRecord; size: number }) {
  const [broken, setBroken] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const frame = useVideoThumb(asset, box);
  if (asset.kind === 'image' && asset.thumbnail_status !== 'failed' && !broken) {
    return (
      <img
        className="thumb__img"
        src={thumbnailUrl(asset.id)}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => {
          setBroken(true);
        }}
      />
    );
  }
  if (typeof frame === 'string') {
    return <img className="thumb__img" data-frame="video" src={frame} alt="" draggable={false} />;
  }
  return (
    <span ref={box} className="thumb__icon">
      <Icon name={ASSET_KIND[asset.kind].icon} size={size} />
    </span>
  );
}
