import { useState } from 'react';
import { Icon } from './Icon.js';
import { t } from './i18n.js';

/** Trim, drop empties and duplicates, keep order; the service caps tags at 64 × 64 characters. */
export function addTags(current: readonly string[], input: string): string[] {
  const next = [...current];
  for (const raw of input.split(/[,，、\s]+/)) {
    const tag = raw.replace(/^#/, '').trim().slice(0, 64);
    if (tag !== '' && !next.includes(tag) && next.length < 64) next.push(tag);
  }
  return next;
}

/**
 * Tag chips with an inline input. Enter or a comma adds; Backspace on an empty
 * input removes the last tag. Nothing happens while an input method is composing.
 */
export function TagEditor({
  tags,
  disabled,
  onChange,
}: {
  tags: readonly string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = useState('');
  const commit = () => {
    const next = addTags(tags, text);
    setText('');
    if (next.length !== tags.length) onChange(next);
  };
  return (
    <div className="tags" role="group" aria-label={t('assets.tags')}>
      {tags.map((tag) => (
        <span key={tag} className="tag">
          #{tag}
          {!disabled && (
            <button
              type="button"
              className="tag__remove"
              aria-label={t('assets.removeTag', { tag })}
              onClick={() => {
                onChange(tags.filter((x) => x !== tag));
              }}
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          className="tags__input"
          aria-label={t('assets.newTag')}
          placeholder={tags.length === 0 ? t('assets.addTags') : '＋'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && text === '' && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
        />
      )}
    </div>
  );
}
