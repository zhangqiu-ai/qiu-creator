export type RevisionCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_base'; current: string }
  | { ok: false; reason: 'stale_base'; current: string; base: string };

/**
 * Decide whether an edit based on `base` may be applied when the work is at
 * `current`. Anything other than an exact match is a conflict; callers must
 * never fall back to "last write wins".
 */
export function checkRevision(base: string | null | undefined, current: string): RevisionCheck {
  if (base === undefined || base === null || base === '') {
    return { ok: false, reason: 'missing_base', current };
  }
  if (base !== current) {
    return { ok: false, reason: 'stale_base', current, base };
  }
  return { ok: true };
}

/**
 * Parse an `If-Match` header into revision ids. Accepts strong or weak ETags
 * (`"id"`, `W/"id"`) and bare ids. Returns `null` for a missing header and
 * `['*']` for the wildcard.
 */
export function parseIfMatch(header: string | undefined): string[] | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (trimmed === '*') return ['*'];
  return trimmed
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^W\//, '')
        .replace(/^"(.*)"$/, '$1'),
    )
    .filter((part) => part.length > 0);
}

/** Format a revision id as a strong ETag. */
export function revisionEtag(revisionId: string): string {
  return `"${revisionId}"`;
}

/**
 * Resolve the effective base revision from a body field and an `If-Match`
 * header. The wildcard `*` is deliberately not accepted as a base: edits must
 * name the revision they were made against. When body and header disagree,
 * the one that does not match `current` is returned so the check fails.
 */
export function resolveBaseRevision(
  bodyBase: string | undefined,
  ifMatch: string | undefined,
  current: string,
): string | null {
  const tags = parseIfMatch(ifMatch);
  const headerBase = tags?.find((t) => t !== '*');
  if (bodyBase !== undefined && headerBase !== undefined && bodyBase !== headerBase) {
    return bodyBase === current ? headerBase : bodyBase;
  }
  return bodyBase ?? headerBase ?? null;
}
