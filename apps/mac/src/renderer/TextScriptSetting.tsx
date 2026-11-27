import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { TextScript, TextScriptSetting } from '@qiu-creator/contracts';
import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';
import { radioKeys } from './radio-keys.js';
import { SCRIPT_OPTIONS, scriptName } from './text-script-ui.js';

/**
 * 設定 › Agent 與 MCP › 作品文字字體 (QC-109): 簡體 or 繁體 for the text agents
 * write into works, saved as soon as one is picked (like 語言). A null
 * `updated_at` means the default (簡體) is still in use.
 */
export function TextScriptSection({ client }: { client: CreatorHubClient }) {
  const [setting, setSetting] = useState<TextScriptSetting | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last value the service confirmed; a failed save goes back to it. */
  const confirmed = useRef<TextScriptSetting | null>(null);
  /** Saves go out one after another, so the service ends on the last pick. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(0);

  useEffect(() => {
    let live = true;
    client.settings
      .textScript()
      .then((s) => {
        confirmed.current = s;
        if (live) setSetting(s);
      })
      .catch(() => {
        if (live) setError(t('agents.scriptLoadFailed'));
      });
    return () => {
      live = false;
    };
  }, [client]);

  // Show the choice at once. Every pick is saved, in order (a quick change of mind while
  // the first save is on its way is not lost); only the last pick's answer is shown, and a
  // failure puts back what the service last confirmed.
  const pick = (script: TextScript) => {
    if (setting === null || script === setting.script) return;
    setSetting({ ...setting, script });
    setError(null);
    const id = ++latest.current;
    const save = queue.current.then(() => client.settings.setTextScript({ script }));
    queue.current = save.catch(() => undefined);
    save
      .then((saved) => {
        confirmed.current = saved;
        if (id !== latest.current) return;
        setSetting(saved);
      })
      .catch(() => {
        if (id !== latest.current) return;
        setSetting(confirmed.current);
        setError(t('agents.scriptSaveFailed'));
      });
  };

  return (
    <section className="set-g ag-script" aria-labelledby="set-script-h">
      <h2 className="set-g__t" id="set-script-h">
        {t('agents.scriptTitle')}
      </h2>
      <div className="set-list">
        <div className="set-row set-row--top">
          <div className="set-row__k">
            <b id="set-script-row">
              {t('agents.scriptRow')}
              {setting !== null && setting.updated_at === null && (
                <span className="faint ag-script__default">{t('agents.scriptIsDefault')}</span>
              )}
            </b>
            <span className="set-row__wrap" id="set-script-note">
              {t('agents.scriptNote')}
            </span>
          </div>
          <div
            className="seg"
            role="radiogroup"
            aria-labelledby="set-script-h"
            aria-describedby="set-script-note"
            aria-busy={setting === null}
          >
            {SCRIPT_OPTIONS.map((script, i) => {
              const checked = setting?.script === script;
              return (
                <button
                  key={script}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-pressed={checked}
                  disabled={setting === null}
                  tabIndex={checked || (setting === null && i === 0) ? 0 : -1}
                  onClick={() => {
                    pick(script);
                  }}
                  onKeyDown={(e) => {
                    radioKeys(e, SCRIPT_OPTIONS, i, pick);
                  }}
                >
                  {scriptName(script)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
