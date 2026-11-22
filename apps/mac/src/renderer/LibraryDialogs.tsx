import { WORK_TRASH_RETENTION_DAYS, type WorkRef } from '@qiu-creator/contracts';

/** What the delete and tag dialogs read of a work: a loaded card or a ⌘A ref (QC-067). */
type DialogWork = Pick<WorkRef, 'id' | 'title' | 'tags' | 'storage_mode' | 'external_state'>;
import { useState } from 'react';
import { Dialog } from './Dialog.js';
import { t } from './i18n.js';
import { parseTags, unionTags } from './library-trash.js';

/**
 * Confirmations for 作品庫 (QC-052). 刪除 can be undone from 回收站, so
 * its button takes the focus; 永久刪除 cannot, so 取消 does
 * (`qiuge-design/cases/kubai-999-009-overlay-selection`).
 */

export function DeleteDialog({
  works,
  onCancel,
  onConfirm,
}: {
  works: readonly DialogWork[];
  onCancel: () => void;
  onConfirm: (moveOriginal: boolean) => void;
}) {
  const [moveOriginal, setMoveOriginal] = useState(false);
  const one = works.length === 1 ? works[0] : undefined;
  const external = works.some((w) => w.storage_mode === 'external');
  // Only a single external work whose file is there can also send that file to the Trash.
  const canMoveOriginal =
    one !== undefined && one.storage_mode === 'external' && one.external_state === 'present';
  return (
    <Dialog
      title={
        one === undefined
          ? t('workActions.confirmDeleteMany', { count: works.length })
          : t('workActions.confirmDeleteOne', { title: one.title })
      }
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn dialog__primary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger-solid"
            data-autofocus
            onClick={() => {
              onConfirm(canMoveOriginal && moveOriginal);
            }}
          >
            {t('workActions.deleteShort')}
          </button>
        </>
      }
    >
      <p>{t('workActions.deleteBody', { days: WORK_TRASH_RETENTION_DAYS })}</p>
      {external && <p className="faint">{t('workActions.deleteExternalBody')}</p>}
      {canMoveOriginal && (
        <label className="lib-dialog__opt">
          <input
            type="checkbox"
            checked={moveOriginal}
            onChange={(e) => {
              setMoveOriginal(e.target.checked);
            }}
          />
          <span>
            <span>{t('workActions.deleteOriginal')}</span>
            <span className="faint">{t('workActions.deleteOriginalHint')}</span>
          </span>
        </label>
      )}
    </Dialog>
  );
}

/** 永久刪除 chosen works, or (with `empty`) everything in 回收站. */
export function PurgeDialog({
  works,
  empty,
  count,
  onCancel,
  onConfirm,
}: {
  works: readonly DialogWork[];
  empty: boolean;
  /** For `empty`: how many works 回收站 holds. */
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const one = !empty && works.length === 1 ? works[0] : undefined;
  const external = empty || works.some((w) => w.storage_mode === 'external');
  return (
    <Dialog
      title={
        empty
          ? t('workActions.confirmEmpty')
          : one === undefined
            ? t('workActions.confirmPurgeMany', { count: works.length })
            : t('workActions.confirmPurgeOne', { title: one.title })
      }
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn dialog__primary" data-autofocus onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--danger-solid" onClick={onConfirm}>
            {empty ? t('workActions.emptyTrash') : t('workActions.purgeShort')}
          </button>
        </>
      }
    >
      <p>{empty ? t('workActions.emptyBody', { count }) : t('workActions.purgeBody')}</p>
      {external && <p className="faint">{t('workActions.purgeExternalBody')}</p>}
    </Dialog>
  );
}

/** 加標籤 (type them) or 移除標籤 (tick the ones the selection has). */
export function TagsDialog({
  mode,
  works,
  onCancel,
  onApply,
}: {
  mode: 'add' | 'remove';
  works: readonly DialogWork[];
  onCancel: () => void;
  onApply: (tags: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const existing = unionTags(works);
  const tags = mode === 'add' ? parseTags(text) : existing.filter((tag) => picked.has(tag));
  const apply = () => {
    if (tags.length > 0) onApply(tags);
  };
  return (
    <Dialog
      title={t(mode === 'add' ? 'workActions.addTagsTitle' : 'workActions.removeTagsTitle', {
        count: works.length,
      })}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn dialog__primary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={tags.length === 0}
            onClick={apply}
          >
            {t('workActions.apply')}
          </button>
        </>
      }
    >
      {mode === 'add' ? (
        <label className="lib-dialog__field">
          <span>{t('workActions.tagsField')}</span>
          <input
            className="input"
            data-autofocus
            value={text}
            placeholder={t('workActions.tagsPlaceholder')}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              // ↩ while the IME is composing picks the candidate; only a plain ↩ applies.
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              apply();
            }}
          />
          {tags.length > 0 && (
            <span className="lib-dialog__tags">{tags.map((tag) => `#${tag}`).join(' ')}</span>
          )}
        </label>
      ) : existing.length === 0 ? (
        <p className="faint">{t('workActions.noTags')}</p>
      ) : (
        <fieldset className="lib-dialog__pick">
          <legend className="faint">{t('workActions.tagsPick')}</legend>
          {existing.map((tag, i) => (
            <label key={tag} className="lib-dialog__opt">
              <input
                type="checkbox"
                {...(i === 0 ? { 'data-autofocus': true } : {})}
                checked={picked.has(tag)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(tag);
                  else next.delete(tag);
                  setPicked(next);
                }}
              />
              <span>#{tag}</span>
            </label>
          ))}
        </fieldset>
      )}
    </Dialog>
  );
}
