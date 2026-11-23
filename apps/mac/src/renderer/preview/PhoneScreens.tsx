import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  useSensor,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Platform } from '@qiu-creator/contracts';
import { PLATFORM_UI, type PlatformUi, type PlatformUiRow } from '@qiu-creator/platform-preview';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { sortTransition, useDragSensors } from '../dnd-motion.js';
import { t } from '../i18n.js';
import { Icon } from '../Icon.js';
import { currentMotionMode, useMotionMode } from '../motion-mode.js';
import type { PhoneActions, PhoneBlock, PhoneImage, PhoneModel, Screen } from './phone-model.js';
import './phone.css';

/*
 * The three screens of each simulated platform (QC-084, PT-20261123-001 v2):
 * 發布編輯 (editable in place), 刷到時 and 正文 (read-only, taps go back to
 * editing). The stage draws the bezel, status bar and pager; each screen is
 * one page of it. Platform screens use fixed colours, never the App theme.
 */

type Focus = 'title' | 'cover' | 'tags' | null;

// ---------------------------------------------------------------- pure helpers

/** Light or dark page for a platform's screen (抖音 is dark throughout; 視頻號 after publishing). */
export function screenTone(platform: Platform, screen: Screen): 'light' | 'dark' {
  if (platform === 'douyin') return 'dark';
  if (platform === 'wechat_channels' && screen !== 'publish') return 'dark';
  return 'light';
}

/** The status bar's background, matching the top of each screen. */
export function statusBarColor(platform: Platform, screen: Screen): string {
  if (screenTone(platform, screen) === 'dark') return screen === 'publish' ? '#111' : '#000';
  if (screen === 'feed' && platform === 'xiaohongshu') return '#F5F5F5';
  if (screen === 'feed' && platform === 'wechat_mp') return '#EDEDED';
  if (screen === 'publish' && platform === 'wechat_mp') return '#F7F7F7';
  return '#fff';
}

/** Code points in a string. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/** The first `max` code points on one line, with an ellipsis when there is more. */
export function excerpt(text: string, max: number): string {
  const flat = codePoints(text.replace(/\s+/g, ' ').trim());
  return flat.length > max ? `${flat.slice(0, max).join('')}…` : flat.join('');
}

/** `12/20`, or just `12` without a limit. */
export function countText(count: number, limit: number | null): string {
  return limit === null ? String(count) : `${count} / ${limit}`;
}

export function isOver(count: number, limit: number | null): boolean {
  return limit !== null && count > limit;
}

/** Where a block stands against the platform's cut. */
export type BlockCut =
  { kind: 'whole' } | { kind: 'cut' } | { kind: 'split'; before: string; after: string };

/**
 * Splits the body blocks at `cutAt` (code points into the body text). Text
 * blocks are placed by `at`; an image is cut when it comes after the cut.
 */
export function splitBlocks(blocks: readonly PhoneBlock[], cutAt: number | null): BlockCut[] {
  let past = false;
  return blocks.map((block): BlockCut => {
    if (cutAt === null) return { kind: 'whole' };
    if (block.kind === 'image' || block.at < 0) return past ? { kind: 'cut' } : { kind: 'whole' };
    const chars = codePoints(block.text);
    if (block.at >= cutAt) {
      past = true;
      return { kind: 'cut' };
    }
    if (block.at + chars.length <= cutAt) return { kind: 'whole' };
    past = true;
    const k = cutAt - block.at;
    return { kind: 'split', before: chars.slice(0, k).join(''), after: chars.slice(k).join('') };
  });
}

/** Scrolls `el` into the middle of the scroll container `root`, without moving any outer scroller. */
function scrollWithin(root: HTMLElement | null, el: HTMLElement | null, smooth: boolean): void {
  if (root === null || el === null) return;
  const r = root.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  const top = root.scrollTop + e.top - r.top - (r.height - e.height) / 2;
  root.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

// ---------------------------------------------------------------- small parts

function Spacer() {
  return <div className="ph-sbspace" aria-hidden="true" />;
}

function Img({ src, className }: { src: string | null; className?: string }) {
  if (src === null)
    return (
      <span className={`ph-noimg ${className ?? ''}`}>
        <span>{t('phone.noCover')}</span>
      </span>
    );
  return <img className={`ph-img ${className ?? ''}`} src={src} alt="" draggable={false} />;
}

function Nav({ ui }: { ui: PlatformUi }) {
  return (
    <div className="ph-nav" aria-hidden="true">
      <span className="ph-nav__back">‹</span>
      <span className="ph-nav__title">{ui.publishNavTitle}</span>
      <span className={`ph-nav__act${ui.publishNavActionStrong ? ' ph-nav__act--go' : ''}`}>
        {ui.publishNavAction}
      </span>
    </div>
  );
}

function Row({ row, author }: { row: PlatformUiRow; author: string }) {
  return (
    <div className="ph-row" aria-hidden="true">
      {row.icon === '' ? null : <span className="ph-row__icon">{row.icon}</span>}
      <span>{row.label}</span>
      <span className="ph-row__value">{row.author === true ? author : row.value || '›'}</span>
    </div>
  );
}

function OwnChip({ own }: { own: boolean }) {
  return (
    <span className={`ph-own${own ? '' : ' ph-own--follow'}`}>
      {own ? t('phone.own') : t('phone.following')}
    </span>
  );
}

function FollowLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ph-link" onClick={onClick}>
      {t('phone.followAgain')}
    </button>
  );
}

function AiButton({
  label,
  onClick,
  spark,
}: {
  label: string;
  onClick: () => void;
  spark?: boolean;
}) {
  return (
    <button type="button" className="ph-ai" onClick={onClick}>
      {spark === true ? <Icon name="spark" size={12} /> : null}
      {label}
    </button>
  );
}

function Pencil() {
  return (
    <svg className="ph-pencil" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16Z" />
    </svg>
  );
}

/** 「正文跟隨左邊原稿 · 在原稿編輯」 on the body screen. */
function SourceHint({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ph-srchint" onClick={onClick}>
      <Pencil />
      <span>{t('phone.bodyFollows')}</span>
      <span aria-hidden="true">·</span>
      <span className="ph-srchint__go">{t('phone.editInSource')}</span>
    </button>
  );
}

/** A tappable area on the read-only screens (title, cover): back to editing that field. */
function Tap({
  label,
  onTap,
  className,
  children,
}: {
  label: string;
  onTap: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ph-tap ${className ?? ''}`}
      aria-label={label}
      onClick={onTap}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- publish widgets

function TitleField({
  model,
  actions,
  inputRef,
}: {
  model: PhoneModel;
  actions: PhoneActions;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const ui = PLATFORM_UI[model.platform];
  const { title } = model;
  const over = isOver(title.length, title.limit);
  const composingRef = useRef(false);

  // Grow with the text (the title may wrap), never show a scrollbar.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [inputRef, title.value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A title is one line: Enter only commits an input method's candidate.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !composingRef.current)
      e.preventDefault();
  };

  return (
    <>
      <div className="ph-field">
        <textarea
          ref={inputRef}
          className="ph-title"
          rows={1}
          value={title.value}
          placeholder={ui.titlePlaceholder}
          aria-label={t('phone.titleLabel')}
          spellCheck={false}
          onChange={(e) => {
            actions.editTitle(e.target.value.replace(/\n/g, ''));
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
            actions.composing(true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            actions.composing(false);
          }}
        />
      </div>
      <div className="ph-meta">
        <OwnChip own={title.own} />
        {title.own ? (
          <FollowLink
            onClick={() => {
              actions.follow('title');
            }}
          />
        ) : null}
        <span className="ph-grow" />
        <span
          className={`ph-count${over ? ' ph-count--over' : ''}`}
          aria-label={
            title.limit === null
              ? undefined
              : t('phone.titleCount', { count: title.length, limit: title.limit })
          }
        >
          {title.limit === null ? title.length : `${title.length}/${title.limit}`}
        </span>
        <AiButton label={t('phone.aiTitle')} spark onClick={actions.openTitleAi} />
      </div>
    </>
  );
}

function SortableThumb({
  image,
  index,
  square,
}: {
  image: PhoneImage;
  index: number;
  square: boolean;
}) {
  const mode = useMotionMode();
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: image.id,
    transition: sortTransition(mode),
  });
  return (
    <span
      ref={setNodeRef}
      className={`ph-thumb${square ? ' ph-thumb--sq' : ''}${isDragging ? ' ph-thumb--drag' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={index === 0 ? t('phone.coverImage') : t('phone.imageN', { index: index + 1 })}
    >
      <img src={image.url} alt="" draggable={false} />
      {index === 0 ? (
        <span className="ph-thumb__cv">{t('phone.coverBadge')}</span>
      ) : (
        <span className="ph-thumb__no">{index + 1}</span>
      )}
    </span>
  );
}

function ImageStrip({
  model,
  actions,
  stripRef,
}: {
  model: PhoneModel;
  actions: PhoneActions;
  stripRef?: RefObject<HTMLDivElement | null>;
}) {
  const images = model.images.value;
  const square = model.platform === 'wechat_channels';
  const ids = useMemo(() => images.map((i) => i.id), [images]);
  const pointer = useDragSensors();
  const keyboard = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  const sensors = useMemo(() => [...pointer, keyboard], [pointer, keyboard]);
  const position = (id: string | number) => ids.indexOf(String(id)) + 1;

  const announcements: Announcements = {
    onDragStart: ({ active }) => t('phone.dndPicked', { position: position(active.id) }),
    onDragOver: ({ active, over }) =>
      t('phone.dndPosition', {
        position: position(over?.id ?? active.id),
        total: ids.length,
      }),
    onDragEnd: ({ active, over }) =>
      t('phone.dndDropped', { position: position(over?.id ?? active.id) }),
    onDragCancel: () => t('phone.dndCancelled'),
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over === null || e.over.id === e.active.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from < 0 || to < 0) return;
    actions.reorderImages(arrayMove(ids, from, to));
  };

  const hint =
    model.images.limit === null
      ? t('phone.imagesHintNoLimit', { count: images.length })
      : t('phone.imagesHint', { count: images.length, limit: model.images.limit });

  return (
    <div ref={stripRef} className="ph-images">
      {images.length === 0 ? (
        <div className="ph-strip">
          <span className={`ph-thumb ph-thumb--empty${square ? ' ph-thumb--sq' : ''}`}>
            <Img src={null} />
          </span>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            restoreFocus: true,
            announcements,
            screenReaderInstructions: { draggable: t('phone.dndInstructions') },
          }}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
            <div className="ph-strip" role="list" aria-label={t('phone.imagesLabel')}>
              {images.map((image, i) => (
                <SortableThumb key={image.id} image={image} index={i} square={square} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      <div className="ph-meta ph-meta--images">
        <span className={isOver(images.length, model.images.limit) ? 'ph-count--over' : ''}>
          {hint}
        </span>
        <span className="ph-grow" />
        <AiButton label={t('phone.aiCover')} spark onClick={actions.openCover} />
        <AiButton label={t('phone.pickCover')} onClick={actions.openCover} />
      </div>
      <OwnRows model={model} actions={actions} images />
    </div>
  );
}

/** 自訂 + 改回跟隨原稿 for images and the cover, only when the platform overrides them. */
function OwnRows({
  model,
  actions,
  images,
}: {
  model: PhoneModel;
  actions: PhoneActions;
  images: boolean;
}) {
  const rows: { key: 'images' | 'cover'; label: string }[] = [];
  if (images && model.images.own) rows.push({ key: 'images', label: t('phone.imagesLabel') });
  if (model.cover.own) rows.push({ key: 'cover', label: t('phone.coverBadge') });
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className="ph-meta ph-meta--own">
          {row.key === 'cover' ? <span className="ph-meta__label">{row.label}</span> : null}
          <OwnChip own />
          <FollowLink
            onClick={() => {
              actions.follow(row.key);
            }}
          />
        </div>
      ))}
    </>
  );
}

function BodyMini({ model, actions }: { model: PhoneModel; actions: PhoneActions }) {
  const { body } = model;
  const over = isOver(body.length, body.limit);
  return (
    <div className="ph-bodymini">
      <div className="ph-bodymini__txt">{excerpt(body.text, 92)}</div>
      <div className="ph-bodymini__foot">
        <span>{t('phone.bodyFollows')}</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="ph-link"
          onClick={() => {
            actions.editSource(body.blocks[0]?.sourceStart ?? 0);
          }}
        >
          {t('phone.editInSource')}
        </button>
        <span className={`ph-bodymini__n${over ? ' ph-count--over' : ''}`}>
          {countText(body.length, body.limit)}
        </span>
      </div>
    </div>
  );
}

function TagRow({
  model,
  actions,
  tagsRef,
}: {
  model: PhoneModel;
  actions: PhoneActions;
  tagsRef: RefObject<HTMLDivElement | null>;
}) {
  const tags = model.tags.value;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Opened by a click on 「＋ 話題」: type straight away.
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  // Tags that just arrived pop in; compare by content, not array identity.
  const signature = tags.join('\u0000');
  const [seen, setSeen] = useState({ signature, tags });
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  if (seen.signature !== signature) {
    setFresh(new Set(tags.filter((tag) => !seen.tags.includes(tag))));
    setSeen({ signature, tags });
  }

  const commit = () => {
    if (draft.trim() !== '') actions.addTags(draft);
    setDraft('');
  };

  return (
    <div ref={tagsRef} className="ph-tags" aria-label={t('phone.tagsLabel')} role="group">
      {tags.map((tag) => (
        <span key={tag} className={`ph-tag${fresh.has(tag) ? ' ph-tag--new' : ''}`}>
          #{tag}
          <button
            type="button"
            className="ph-tag__x"
            aria-label={t('phone.removeTag', { tag })}
            onClick={() => {
              actions.removeTag(tag);
            }}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <span className="ph-tag ph-tag--input">
          #
          <input
            ref={inputRef}
            value={draft}
            aria-label={t('phone.addTagLabel')}
            size={Math.max(4, codePoints(draft).length + 1)}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => {
              commit();
              setAdding(false);
            }}
          />
        </span>
      ) : (
        <button
          type="button"
          className="ph-tag ph-tag--add"
          onClick={() => {
            setAdding(true);
          }}
        >
          {t('phone.addTag')}
        </button>
      )}
      <span className="ph-grow" />
      {model.tags.own ? (
        <>
          <OwnChip own />
          <FollowLink
            onClick={() => {
              actions.follow('tags');
            }}
          />
        </>
      ) : null}
      <span className={`ph-count${isOver(tags.length, model.tags.limit) ? ' ph-count--over' : ''}`}>
        {countText(tags.length, model.tags.limit)}
      </span>
    </div>
  );
}

function Buttons({ ui }: { ui: PlatformUi }) {
  if (ui.publishButton === '') return null;
  return (
    <div className="ph-btns" aria-hidden="true">
      <span className="ph-btn ph-btn--ghost">{ui.draftButton}</span>
      <span className="ph-btn ph-btn--go">{ui.publishButton}</span>
    </div>
  );
}

// ---------------------------------------------------------------- screens

function rootClass(platform: Platform, screen: Screen): string {
  return `ph-scr ph-scr--${platform} ph-scr--${screen}${
    screenTone(platform, screen) === 'dark' ? ' ph-scr--dark' : ''
  }`;
}

/** 發布編輯: title, images, cover and tags edited in place; the body follows the source. */
export function PublishScreen({
  model,
  actions,
  focus,
}: {
  model: PhoneModel;
  actions: PhoneActions;
  focus: Focus;
}) {
  const ui = PLATFORM_UI[model.platform];
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const tagsRef = useRef<HTMLDivElement>(null);

  // Arriving from a tap on the feed or body screen: bring that field into view once.
  useEffect(() => {
    if (focus === null) return;
    const smooth = currentMotionMode() === 'full';
    if (focus === 'title') {
      const el = titleRef.current;
      el?.focus({ preventScroll: true });
      scrollWithin(rootRef.current, el, smooth);
    } else {
      scrollWithin(rootRef.current, focus === 'cover' ? coverRef.current : tagsRef.current, smooth);
    }
  }, [focus]);

  const title = <TitleField model={model} actions={actions} inputRef={titleRef} />;
  const strip = <ImageStrip model={model} actions={actions} stripRef={coverRef} />;
  const body = <BodyMini model={model} actions={actions} />;
  const tags = <TagRow model={model} actions={actions} tagsRef={tagsRef} />;
  const rows = ui.settingRows.map((row) => <Row key={row.label} row={row} author={model.author} />);

  let content: ReactNode;
  if (model.platform === 'wechat_mp') {
    content = (
      <>
        <Nav ui={ui} />
        <div ref={coverRef} className="ph-wxcover-wrap">
          <button
            type="button"
            className="ph-cover ph-cover--wx"
            style={{ aspectRatio: String(model.coverRatio) }}
            aria-label={t('phone.editCover')}
            onClick={actions.openCover}
          >
            <Img src={model.cover.value} />
            <span className="ph-cover__tag">
              {t('phone.coverRatio', { ratio: model.coverRatioLabel })}
            </span>
            {model.cover.value === null ? null : (
              <span className="ph-cover__sq">
                <img src={model.cover.value} alt="" draggable={false} />
              </span>
            )}
          </button>
          <div className="ph-meta ph-meta--images">
            <AiButton label={t('phone.aiCover')} spark onClick={actions.openCover} />
            <AiButton label={t('phone.pickFromBody')} onClick={actions.openCover} />
          </div>
          <OwnRows model={model} actions={actions} images={false} />
        </div>
        <div className="ph-card">
          {title}
          {ui.infoRows.map((row) => (
            <Row key={row.label} row={row} author={model.author} />
          ))}
        </div>
        <div className="ph-card ph-card--pad">{body}</div>
        <div className="ph-card">{rows}</div>
        <div className="ph-end" />
      </>
    );
  } else if (model.platform === 'douyin') {
    content = (
      <>
        <Nav ui={ui} />
        <div className="ph-dyhead">
          <div className="ph-dyhead__title">{title}</div>
          <div ref={coverRef} className="ph-dyhead__cover">
            <button
              type="button"
              className="ph-cover"
              style={{ aspectRatio: '3 / 4' }}
              aria-label={t('phone.editCover')}
              onClick={actions.openCover}
            >
              <Img src={model.cover.value} />
              <span className="ph-cover__tag">{t('phone.pickCover')}</span>
            </button>
          </div>
        </div>
        {body}
        {tags}
        <ImageStrip model={model} actions={actions} />
        {rows}
        <Buttons ui={ui} />
      </>
    );
  } else if (model.platform === 'wechat_channels') {
    content = (
      <>
        <Nav ui={ui} />
        {strip}
        {body}
        <div className="ph-short">{ui.shortTitleLabel}</div>
        {title}
        {tags}
        {rows}
        <div className="ph-end" />
      </>
    );
  } else {
    content = (
      <>
        <Nav ui={ui} />
        {strip}
        {title}
        {body}
        {tags}
        {rows}
        <Buttons ui={ui} />
      </>
    );
  }

  return (
    <div ref={rootRef} className={rootClass(model.platform, 'publish')} data-screen="publish">
      <Spacer />
      {content}
    </div>
  );
}

/** 刷到時: how the post looks among others (read-only; title and cover go back to editing). */
export function FeedScreen({ model, actions }: { model: PhoneModel; actions: PhoneActions }) {
  const ui = PLATFORM_UI[model.platform];
  const goTitle = () => {
    actions.goEdit('title');
  };
  const goCover = () => {
    actions.goEdit('cover');
  };
  const cover = (ratio: number) => (
    <Tap label={t('phone.editCover')} onTap={goCover} className="ph-feedcover">
      <span className="ph-ratio" style={{ aspectRatio: String(ratio) }}>
        <Img src={model.cover.value} />
      </span>
    </Tap>
  );
  const titleTap = (className: string) => (
    <Tap label={t('phone.editTitle')} onTap={goTitle} className={className}>
      {model.title.value}
    </Tap>
  );
  const tabs = (
    <div className="ph-ftabs" aria-hidden="true">
      {ui.feedTabs.map((tab, i) => (
        <span key={tab} className={i === ui.feedActiveTab ? 'ph-ftabs__on' : ''}>
          {tab}
        </span>
      ))}
    </div>
  );

  let content: ReactNode;
  if (model.platform === 'xiaohongshu') {
    const other = (i: number) => {
      const card = ui.feedCards[i];
      if (card === undefined) return null;
      return (
        <div className="ph-fcard" aria-hidden="true">
          <span className="ph-fcard__ph" style={{ aspectRatio: String(card.ratio) }} />
          <div className="ph-fcard__t">{card.title}</div>
          <div className="ph-fcard__u">
            <i />
            {ui.feedUser}
            <span>{card.likes}</span>
          </div>
        </div>
      );
    };
    content = (
      <>
        <Spacer />
        {tabs}
        <div className="ph-fgrid">
          <div className="ph-fcol">
            <div className="ph-fcard ph-mine">
              {cover(model.coverRatio)}
              {titleTap('ph-fcard__t')}
              <div className="ph-fcard__u">
                <i className="ph-avatar" />
                {model.author}
                <span>{ui.feedOwnLikes}</span>
              </div>
              <span className="ph-mtag">{t('phone.yourNote')}</span>
            </div>
            {other(0)}
          </div>
          <div className="ph-fcol">
            {other(1)}
            {other(2)}
          </div>
        </div>
      </>
    );
  } else if (model.platform === 'wechat_mp') {
    content = (
      <>
        <Spacer />
        <div className="ph-wxhead" aria-hidden="true">
          {ui.feedHeader}
        </div>
        <div className="ph-wxtime" aria-hidden="true">
          {ui.feedTime}
        </div>
        <div className="ph-wxpush ph-mine">
          <div className="ph-wxpush__acct">
            <i className="ph-avatar ph-avatar--wx" />
            {model.author}
          </div>
          {cover(model.coverRatio)}
          {titleTap('ph-wxpush__title')}
          <div className="ph-wxpush__more" aria-hidden="true">
            <span className="ph-bar" />
            <i />
          </div>
        </div>
        <div className="ph-wxother" aria-hidden="true">
          <i />
          {ui.feedOther}
        </div>
      </>
    );
  } else {
    const dy = model.platform === 'douyin';
    content = (
      <div className={`ph-full${dy ? ' ph-full--dy' : ' ph-full--ch'}`}>
        <div className="ph-full__cover">{cover(dy ? 3 / 4 : 6 / 7)}</div>
        {tabs}
        <div className="ph-full__side" aria-hidden="true">
          {dy ? <i className="ph-avatar ph-avatar--ring" /> : null}
          {ui.feedCounts.map((c) => (
            <span key={c.icon}>
              {c.icon}
              <br />
              {c.value}
            </span>
          ))}
        </div>
        <div className="ph-full__text">
          {dy ? (
            <b className="ph-full__who">@{model.author}</b>
          ) : (
            <div className="ph-full__who">
              <i className="ph-avatar" />
              <b>{model.author}</b>
            </div>
          )}
          {titleTap(dy ? 'ph-full__title' : 'ph-full__title ph-full__title--strong')}
          {dy ? (
            <div className="ph-full__tags">
              {model.tags.value
                .slice(0, 2)
                .map((tag) => `#${tag}`)
                .join(' ')}{' '}
              … {ui.feedMore}
            </div>
          ) : (
            <div className="ph-full__desc">{excerpt(model.body.text, 60)}</div>
          )}
        </div>
        {dy ? (
          <div className="ph-full__nav" aria-hidden="true">
            {ui.feedNav.map((item, i) => (
              <span
                key={item}
                className={i === 0 ? 'ph-full__nav-on' : item === '＋' ? 'ph-full__nav-plus' : ''}
              >
                {item}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={rootClass(model.platform, 'feed')} data-screen="feed">
      {content}
    </div>
  );
}

/** The body as the platform shows it, with the follow highlight and the cut. */
function BodyBlocks({ model, actions }: { model: PhoneModel; actions: PhoneActions }) {
  const { body } = model;
  const rich = model.platform === 'wechat_mp';
  const cuts = splitBlocks(body.blocks, body.cutAt);
  let lineDrawn = false;

  const cutLine = () => {
    if (body.limit === null || body.cutAt === null) return null;
    lineDrawn = true;
    const limit = body.limit;
    return (
      <div className="ph-cutwrap">
        <div className="ph-cutline pv-cutline">
          {t('phone.cutLine', { limit, count: Math.max(0, body.length - body.cutAt) })}
        </div>
        <div className="ph-cutacts">
          <button type="button" className="ph-ai" onClick={actions.markCut}>
            {t('phone.markCut', { limit })}
          </button>
          <button type="button" className="ph-ai" onClick={actions.shorten}>
            <Icon name="spark" size={12} />
            {t('phone.shorten')}
          </button>
        </div>
      </div>
    );
  };

  const out: ReactNode[] = [];
  body.blocks.forEach((block, i) => {
    const cut = cuts[i] ?? { kind: 'whole' };
    if (block.kind === 'image' && !rich) return;
    const current = model.current === i ? ' curp' : '';
    if (cut.kind === 'cut' && !lineDrawn) out.push(<div key="cutline">{cutLine()}</div>);
    const faded = cut.kind === 'cut' ? ' ph-cut' : '';
    if (cut.kind === 'split') {
      out.push(
        <div key={i} data-block={i} className={`ph-blk${current}`}>
          <p>{cut.before}</p>
          {cutLine()}
          <p className="ph-cut">{cut.after}</p>
        </div>,
      );
      return;
    }
    if (block.kind === 'image') {
      out.push(
        <div key={i} data-block={i} className={`ph-blk ph-blk--img${current}${faded}`}>
          <img src={block.src ?? ''} alt="" draggable={false} />
        </div>,
      );
    } else if (rich && block.kind === 'heading') {
      out.push(
        <h3 key={i} data-block={i} className={`ph-blk ph-h${current}${faded}`}>
          {block.text}
        </h3>,
      );
    } else {
      const item = rich && block.kind === 'item' ? ' ph-item' : '';
      out.push(
        <p key={i} data-block={i} className={`ph-blk${item}${current}${faded}`}>
          {block.text}
        </p>,
      );
    }
  });
  return <div className="ph-bodyro">{out}</div>;
}

/** 正文: what a reader sees after tapping in (read-only; follows the source). */
export function BodyScreen({ model, actions }: { model: PhoneModel; actions: PhoneActions }) {
  const ui = PLATFORM_UI[model.platform];
  const goTitle = () => {
    actions.goEdit('title');
  };
  const hint = (
    <SourceHint
      onClick={() => {
        const at = model.current === null ? undefined : model.body.blocks[model.current];
        actions.editSource(at?.sourceStart ?? model.body.blocks[0]?.sourceStart ?? 0);
      }}
    />
  );
  const tagLine =
    model.tags.value.length === 0 ? null : (
      <Tap
        label={t('phone.editTags')}
        onTap={() => {
          actions.goEdit('tags');
        }}
        className="ph-tagline"
      >
        {model.tags.value.map((tag) => `#${tag}`).join(' ')}
      </Tap>
    );

  let content: ReactNode;
  if (model.platform === 'xiaohongshu') {
    const n = model.images.value.length;
    content = (
      <>
        <div className="ph-dhead">
          <span className="ph-dhead__back" aria-hidden="true">
            ‹
          </span>
          <i className="ph-avatar ph-avatar--lg" />
          <b>{model.author}</b>
          <span className="ph-dhead__follow" aria-hidden="true">
            {ui.followButton}
          </span>
        </div>
        <Tap
          label={t('phone.editCover')}
          onTap={() => {
            actions.goEdit('cover');
          }}
          className="ph-dcover"
        >
          <span className="ph-ratio" style={{ aspectRatio: String(model.coverRatio) }}>
            <Img src={model.cover.value} />
          </span>
          {n > 0 ? <span className="ph-dcover__n">1/{n}</span> : null}
        </Tap>
        <div className="ph-dpad">
          <Tap label={t('phone.editTitle')} onTap={goTitle} className="ph-dtitle">
            {model.title.value}
          </Tap>
          {hint}
          <BodyBlocks model={model} actions={actions} />
          {tagLine}
          <div className="ph-date">{model.dateLabel}</div>
        </div>
      </>
    );
  } else if (model.platform === 'wechat_mp') {
    content = (
      <div className="ph-dpad ph-dpad--wx">
        <Tap label={t('phone.editTitle')} onTap={goTitle} className="ph-dtitle ph-dtitle--wx">
          {model.title.value}
        </Tap>
        <div className="ph-wxby">
          {model.author} <span>· {model.dateLabel}</span>
        </div>
        {hint}
        <BodyBlocks model={model} actions={actions} />
      </div>
    );
  } else {
    content = (
      <div className="ph-dpad ph-dpad--dark">
        <div className="ph-dwho">
          <i className="ph-avatar ph-avatar--lg" />
          <b>@{model.author}</b>
        </div>
        <Tap label={t('phone.editTitle')} onTap={goTitle} className="ph-dtitle ph-dtitle--sm">
          {model.title.value}
        </Tap>
        {hint}
        <BodyBlocks model={model} actions={actions} />
        {tagLine}
        <div className="ph-date">{model.dateLabel}</div>
      </div>
    );
  }

  return (
    <div className={rootClass(model.platform, 'body')} data-screen="body">
      <Spacer />
      {content}
    </div>
  );
}
