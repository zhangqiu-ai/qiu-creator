import type { ProjectRules, RuleOutcome, RuleReason } from '@qiu-creator/contracts';
import { t } from './i18n.js';

/**
 * Project rules and agent assignments in the app (QC-091 on the QC-092
 * API), pure parts: reasons in the user's language (the service sends a
 * Traditional Chinese sentence only), and adding a value to a rule list.
 */

export type RuleField = keyof ProjectRules;

export const RULE_FIELDS: readonly RuleField[] = ['keywords', 'tags', 'folders', 'domains'];

export const EMPTY_RULES: ProjectRules = { keywords: [], tags: [], folders: [], domains: [] };

export const RULE_FIELD_LABEL: Readonly<Record<RuleField, string>> = {
  get keywords() {
    return t('agents.fieldKeywords');
  },
  get tags() {
    return t('agents.fieldTags');
  },
  get folders() {
    return t('agents.fieldFolders');
  },
  get domains() {
    return t('agents.fieldDomains');
  },
};

/** One reason in words, built from its kind and value (not the service's sentence). */
export function reasonText(r: Pick<RuleReason, 'kind' | 'value'>): string {
  switch (r.kind) {
    case 'keyword_title':
      return t('agents.reasonKeywordTitle', { value: r.value });
    case 'keyword_body':
      return t('agents.reasonKeywordBody', { value: r.value });
    case 'tag':
      return t('agents.reasonTag', { value: r.value.replace(/^#/, '') });
    case 'folder':
      return t('agents.reasonFolder', { value: r.value });
    case 'domain':
      return t('agents.reasonDomain', { value: r.value });
  }
}

/** All reasons, strongest first, or 「沒有符合的規則」. */
export function reasonsText(
  reasons: readonly Pick<RuleReason, 'kind' | 'value' | 'weight'>[],
): string {
  if (reasons.length === 0) return t('agents.noMatch');
  return [...reasons]
    .sort((a, b) => b.weight - a.weight)
    .map(reasonText)
    .join(t('agents.reasonSep'));
}

export function outcomeLabel(outcome: RuleOutcome): string {
  return t(
    outcome === 'auto'
      ? 'agents.outcomeAuto'
      : outcome === 'suggest'
        ? 'agents.outcomeSuggest'
        : 'agents.outcomeNone',
  );
}

/** `0.92` (two decimals, as the prototype shows scores). */
export function scoreText(score: number): string {
  return score.toFixed(2);
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Add a typed value to one rule list: trimmed, a tag without its `#`, a
 * domain lower-cased and without `https://` or a path. The list, or why
 * the value cannot be added.
 */
export function addRuleValue(
  rules: ProjectRules,
  field: RuleField,
  typed: string,
): { rules: ProjectRules } | { error: string } | null {
  let value = typed.trim();
  if (field === 'tags') value = value.replace(/^#+/, '').trim();
  if (field === 'domains') {
    value = value
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^www\./, '');
    if (value !== '' && !HOSTNAME.test(value)) return { error: t('agents.invalidDomain') };
  }
  if (value === '') return null;
  if (rules[field].includes(value)) return { error: t('agents.valueDuplicate', { value }) };
  return { rules: { ...rules, [field]: [...rules[field], value] } };
}

export function removeRuleValue(
  rules: ProjectRules,
  field: RuleField,
  value: string,
): ProjectRules {
  return { ...rules, [field]: rules[field].filter((v) => v !== value) };
}

export function sameRules(a: ProjectRules, b: ProjectRules): boolean {
  return RULE_FIELDS.every(
    (f) => a[f].length === b[f].length && a[f].every((v, i) => v === b[f][i]),
  );
}
