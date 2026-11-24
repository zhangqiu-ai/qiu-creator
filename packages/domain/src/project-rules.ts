import { foldForSearch } from './search.js';

/**
 * Deterministic project matching (QC-092). No AI: a work is scored against
 * a project's rules (keywords, tags, folders, domains) and each match says
 * why. The same function scores saved works, drafts and rule previews.
 *
 * Each matching signal has a weight; the score combines them as
 * `1 − Π(1 − weight)`, so independent evidence adds up but never passes 1:
 *
 * | signal | weight |
 * | --- | --- |
 * | the work is in a rule folder or mount | 0.9 |
 * | a link or the source is on a rule domain | 0.7 |
 * | a rule keyword in the title | 0.6 |
 * | a rule tag on the work | 0.6 |
 * | a rule keyword only in the body (each distinct keyword) | 0.35 |
 *
 * So a folder alone, or a title keyword with a tag, is ≥ 0.8 (auto); one
 * title keyword, one tag, or two body keywords is 0.5–0.8 (suggest).
 * Keywords match after search folding (case, width, Traditional/Simplified).
 */

export const AUTO_ASSIGN_MIN_SCORE = 0.8;
export const SUGGEST_MIN_SCORE = 0.5;

export const RULE_WEIGHTS = {
  folder: 0.9,
  domain: 0.7,
  keyword_title: 0.6,
  tag: 0.6,
  keyword_body: 0.35,
} as const;

export type RuleReasonKind = keyof typeof RULE_WEIGHTS;

export interface ProjectRulesInput {
  keywords: readonly string[];
  tags: readonly string[];
  /** Mount ids, or absolute folder paths. */
  folders: readonly string[];
  /** Host names; subdomains match too. */
  domains: readonly string[];
}

export interface WorkForRules {
  title: string;
  markdown: string;
  tags: readonly string[];
  /** The work's source label; a URL is matched against domains. */
  source?: string | null;
  /** External works: their mount and the file's absolute path. */
  mountId?: string | null;
  filePath?: string | null;
}

export interface RuleReason {
  kind: RuleReasonKind;
  /** The keyword, tag, folder or domain that matched. */
  value: string;
  weight: number;
  /** A human-readable sentence (Traditional Chinese). */
  text: string;
}

export type RuleOutcome = 'auto' | 'suggest' | 'none';

export interface RuleMatch {
  score: number;
  outcome: RuleOutcome;
  reasons: RuleReason[];
}

export const outcomeOf = (score: number): RuleOutcome =>
  score >= AUTO_ASSIGN_MIN_SCORE ? 'auto' : score >= SUGGEST_MIN_SCORE ? 'suggest' : 'none';

export const isEmptyRules = (r: ProjectRulesInput): boolean =>
  r.keywords.length + r.tags.length + r.folders.length + r.domains.length === 0;

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/gi;

/** Lower-case host names of the work's source URL and every link in its Markdown. */
function hostsOf(work: WorkForRules): Set<string> {
  const hosts = new Set<string>();
  const texts = [work.source ?? '', work.markdown];
  for (const text of texts) {
    for (const m of text.matchAll(URL_RE)) {
      try {
        hosts.add(new URL(m[0]).hostname.toLowerCase());
      } catch {
        // Not a URL after all.
      }
    }
  }
  return hosts;
}

const hostMatches = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

const folderMatches = (work: WorkForRules, folder: string): boolean => {
  if (work.mountId != null && work.mountId === folder) return true;
  if (work.filePath == null || !folder.startsWith('/')) return false;
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return work.filePath.startsWith(prefix);
};

/** Score `work` against `rules`. Empty rules never match. */
export function matchRules(work: WorkForRules, rules: ProjectRulesInput): RuleMatch {
  const reasons: RuleReason[] = [];
  const add = (kind: RuleReasonKind, value: string, text: string): void => {
    reasons.push({ kind, value, weight: RULE_WEIGHTS[kind], text });
  };

  for (const folder of rules.folders) {
    if (folderMatches(work, folder)) add('folder', folder, `位於資料夾「${folder}」`);
  }
  const hosts = hostsOf(work);
  for (const raw of rules.domains) {
    const domain = raw.toLowerCase();
    if ([...hosts].some((h) => hostMatches(h, domain)))
      add('domain', domain, `來源或連結在「${domain}」`);
  }
  const title = foldForSearch(work.title);
  const body = foldForSearch(work.markdown);
  const seen = new Set<string>();
  for (const keyword of rules.keywords) {
    const key = foldForSearch(keyword).trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (title.includes(key)) add('keyword_title', keyword, `標題出現「${keyword}」`);
    else if (body.includes(key)) add('keyword_body', keyword, `正文出現「${keyword}」`);
  }
  const workTags = new Set(work.tags.map((t) => foldForSearch(t)));
  for (const tag of rules.tags) {
    if (workTags.has(foldForSearch(tag))) add('tag', tag, `有標籤「${tag}」`);
  }

  const miss = reasons.reduce((p, r) => p * (1 - r.weight), 1);
  const score = Math.round((1 - miss) * 100) / 100;
  return { score, outcome: outcomeOf(score), reasons };
}
