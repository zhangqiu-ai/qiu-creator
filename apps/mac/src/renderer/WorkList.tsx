import type { Work } from '@qiu-creator/contracts';
import { forwardRef } from 'react';
import { formatTime, WORK_STATUS_LABEL } from './format.js';
import { Icon } from './Icon.js';

export interface WorkListProps {
  works: readonly Work[] | null;
  selectedId: string | null;
  query: string;
  loadError: boolean;
  creating: boolean;
  onQueryChange: (q: string, composing: boolean) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}

export const WorkList = forwardRef<HTMLInputElement, WorkListProps>(
  function WorkList(props, searchRef) {
    const { works } = props;
    return (
      <aside className="sidebar" aria-label="作品庫">
        <div className="sidebar__header">
          <h1 className="sidebar__title">作品</h1>
          <button
            type="button"
            className="icon-button"
            aria-label="新建作品"
            title="新建作品（⌘N）"
            disabled={props.creating}
            onClick={props.onCreate}
          >
            <Icon name="plus" />
          </button>
        </div>
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="搜尋"
          aria-label="搜尋作品"
          value={props.query}
          onChange={(e) => {
            props.onQueryChange(e.target.value, (e.nativeEvent as InputEvent).isComposing);
          }}
          onCompositionEnd={(e) => {
            props.onQueryChange(e.currentTarget.value, false);
          }}
        />
        {props.loadError ? (
          <div className="list-state">
            <span>載入失敗</span>
            <button type="button" onClick={props.onRetry}>
              重試
            </button>
          </div>
        ) : works === null ? (
          <div className="list-state" aria-busy="true">
            載入中
          </div>
        ) : works.length === 0 ? (
          <div className="list-state">{props.query === '' ? '沒有作品' : '沒有符合的作品'}</div>
        ) : (
          <ul className="work-list" role="listbox" aria-label="作品">
            {works.map((w) => (
              <li key={w.id} role="option" aria-selected={w.id === props.selectedId}>
                <button
                  type="button"
                  className="work-list__item"
                  onClick={() => {
                    props.onSelect(w.id);
                  }}
                >
                  <span className="work-list__title">{w.title}</span>
                  <span className="work-list__meta">
                    {WORK_STATUS_LABEL[w.status]} · {formatTime(w.updated_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    );
  },
);
