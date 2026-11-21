import { t } from './i18n.js';
import { redactSecrets } from './server-text.js';

/**
 * The untranslated technical detail of a failure (QC-043): an errno message,
 * a provider's HTTP status and error text. Collapsed by default under
 * 「技術細節」; keys and tokens are removed before display.
 */
export function TechnicalDetails({ text }: { text: string | null | undefined }) {
  if (text === null || text === undefined || text.trim() === '') return null;
  return (
    <details className="tech-details">
      <summary>{t('common.technicalDetails')}</summary>
      <pre className="mono tech-details__text">{redactSecrets(text)}</pre>
    </details>
  );
}
