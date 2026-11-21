import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * QC-042: interface text lives in `@qiu-creator/i18n` catalogs. This fails
 * when Chinese appears in a string, template or JSX text in the app or the
 * UI packages (comments are fine). Test files are not scanned (fixtures).
 */

const root = path.resolve(import.meta.dirname, '../../..');
const SCANNED = [
  'apps/mac/src',
  'packages/markdown-editor-web/src',
  'packages/platform-preview/src',
];

/**
 * Files allowed to hold Chinese, each with the reason. Keep this short:
 * only text that must not be translated.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  // The four platforms' own interface text, shown as the platforms really look
  // (decisions 2026-11-21: not translated).
  'packages/platform-preview/src/templates.ts': 'platform interface text',
};

const HAN = /\p{Script=Han}/u;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function literals(file: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      const text = node.getText(source);
      if (HAN.test(text)) {
        found.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: text.trim().slice(0, 60),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no hard-coded Chinese in the interface (QC-042)', () => {
  it('every string shown to the user comes from the catalogs', () => {
    const problems: string[] = [];
    for (const dir of SCANNED) {
      for (const file of files(path.join(root, dir))) {
        const rel = path.relative(root, file);
        if (rel in ALLOWED) continue;
        for (const hit of literals(file)) problems.push(`${rel}:${String(hit.line)} ${hit.text}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the allow list only names files that exist', () => {
    for (const rel of Object.keys(ALLOWED))
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
  });
});
