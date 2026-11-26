/**
 * The part of opencc-js's `t2cn` and `cn2t` builds this service uses (QC-103).
 * Typed here and reached through the package's `imports` map
 * (`#opencc/t2cn`, `#opencc/cn2t`): the package's own declarations import
 * `./core` without an extension, which NodeNext cannot resolve, so their
 * types would silently become error types.
 */
export function Converter(options: { from: string; to: string }): (text: string) => string;
