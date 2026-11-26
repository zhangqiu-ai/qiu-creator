import { DEFAULT_TEXT_SCRIPT, TEXT_SCRIPTS, type TextScript } from '@qiu-creator/contracts';
import { t } from './i18n.js';

/**
 * 作品文字字體 (QC-109, on the QC-103 API): which Chinese script the server
 * converts agent text into. Globally 簡體 or 繁體 (default 簡體); a project
 * follows the global setting (null) or picks one itself.
 */

export const SCRIPT_OPTIONS: readonly TextScript[] = TEXT_SCRIPTS;

/** A project's choice in the dialog: follow the global setting, or a script of its own. */
export type ProjectScriptChoice = 'follow' | TextScript;
export const PROJECT_SCRIPT_CHOICES: readonly ProjectScriptChoice[] = ['follow', ...TEXT_SCRIPTS];

export function scriptName(script: TextScript): string {
  return script === 'zh-Hant' ? t('agents.scriptHant') : t('agents.scriptHans');
}

/** The project's stored value as a choice; an older server without the field follows. */
export function choiceOf(value: TextScript | null | undefined): ProjectScriptChoice {
  return value === undefined || value === null ? 'follow' : value;
}

/** What to send as `text_script`: null follows the global setting again. */
export function valueOf(choice: ProjectScriptChoice): TextScript | null {
  return choice === 'follow' ? null : choice;
}

/** 跟隨全域, with the global script when it is known. */
export function followLabel(global: TextScript | null): string {
  return global === null
    ? t('agents.scriptFollowBare')
    : t('agents.scriptFollow', { name: scriptName(global) });
}

export function choiceLabel(choice: ProjectScriptChoice, global: TextScript | null): string {
  return choice === 'follow' ? followLabel(global) : scriptName(choice);
}

/** The script agent text in this project ends up in. */
export function effectiveScript(
  project: TextScript | null | undefined,
  global: TextScript | null,
): TextScript {
  return project ?? global ?? DEFAULT_TEXT_SCRIPT;
}
