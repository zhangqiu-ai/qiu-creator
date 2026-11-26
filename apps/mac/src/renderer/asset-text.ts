import { useEffect, useState } from 'react';
import type { AssetText } from '../shared/bridge.js';

/**
 * The text of a Markdown asset for the reader (QC-108), read through the main
 * process and kept for the session by id and content hash, so the gallery
 * view and the full-window preview read a file once and a changed file is
 * read again.
 */

export type TextState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | ({ readonly status: 'ready' } & AssetText);

const cache = new Map<string, AssetText>();
const MAX_CACHED = 20;

export function useAssetText(asset: { id: string; sha256: string }): TextState {
  const key = `${asset.id}:${asset.sha256}`;
  const cached = cache.get(key);
  const [state, setState] = useState<{ key: string; value: TextState }>(() => ({
    key,
    value: cached === undefined ? { status: 'loading' } : { status: 'ready', ...cached },
  }));
  useEffect(() => {
    const hit = cache.get(key);
    if (hit !== undefined) {
      setState({ key, value: { status: 'ready', ...hit } });
      return;
    }
    setState({ key, value: { status: 'loading' } });
    let live = true;
    const read = window.creatorhub?.assetText(asset.id) ?? Promise.resolve(null);
    read
      .then((text) => {
        if (!live) return;
        if (text === null) {
          setState({ key, value: { status: 'failed' } });
          return;
        }
        cache.set(key, text);
        while (cache.size > MAX_CACHED) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        setState({ key, value: { status: 'ready', ...text } });
      })
      .catch(() => {
        if (live) setState({ key, value: { status: 'failed' } });
      });
    return () => {
      live = false;
    };
  }, [key, asset.id]);
  return state.key === key ? state.value : { status: 'loading' };
}
