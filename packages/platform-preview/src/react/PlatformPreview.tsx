import { translate, type Locale } from '@qiu-creator/i18n';
import type { ReactNode } from 'react';
import { PLATFORM_NAME_KEY, type PreviewModel } from '../model.js';

/**
 * DOM templates for the four simulated platforms, from the approved MacPreview
 * board. Neutral, fixed colors (not the app theme): the phone screen always
 * looks like a phone. No platform logos or trademarks, and every preview
 * carries the 模擬 badge. Styles: `@qiu-creator/platform-preview/style.css`.
 */

function Cover({
  url,
  ratio,
  locale,
  children,
}: {
  url: string | null;
  ratio: number;
  locale: Locale;
  children?: ReactNode;
}) {
  return (
    <div className="pp-cover" style={{ aspectRatio: String(ratio) }}>
      {url === null ? (
        <span className="pp-cover__empty">{translate(locale, 'library.noCover')}</span>
      ) : (
        <img className="pp-cover__img" src={url} alt="" draggable={false} />
      )}
      {children}
    </div>
  );
}

function Counter({ model }: { model: PreviewModel }) {
  const shown = model.images.visible.length;
  if (shown <= 1) return null;
  return <span className="pp-counter">1/{shown}</span>;
}

function Xiaohongshu({ model, locale }: { model: PreviewModel; locale: Locale }) {
  return (
    <div className="pp-xhs">
      <div className="pp-xhs__author">
        <span className="pp-avatar" aria-hidden="true" />
        <span>{model.author}</span>
      </div>
      <Cover url={model.coverUrl} ratio={model.template.coverAspectRatio} locale={locale}>
        <Counter model={model} />
      </Cover>
      <div className="pp-xhs__text">
        <div className="pp-xhs__title">{model.title.shown}</div>
        <div className="pp-clamp pp-xhs__body" style={{ WebkitLineClamp: 6 }}>
          {model.body.text}
        </div>
        {model.tags.line !== '' && <div className="pp-link">{model.tags.line}</div>}
        {model.dateLabel !== '' && <div className="pp-meta">{model.dateLabel}</div>}
      </div>
    </div>
  );
}

function WechatArticle({ model, locale }: { model: PreviewModel; locale: Locale }) {
  return (
    <div className="pp-mp">
      <div className="pp-mp__title">{model.title.shown}</div>
      <div className="pp-mp__by">
        <span className="pp-link">{model.author}</span>
        {model.dateLabel !== '' && <span>{model.dateLabel}</span>}
      </div>
      <Cover url={model.coverUrl} ratio={model.template.coverAspectRatio} locale={locale} />
      <div className="pp-mp__body">
        {model.body.blocks.map((b, i) =>
          b.kind === 'heading' ? (
            <p key={i} className="pp-mp__h">
              {b.text}
            </p>
          ) : b.kind === 'item' ? (
            <p key={i} className="pp-mp__li">
              • {b.text}
            </p>
          ) : (
            <p key={i}>{b.text}</p>
          ),
        )}
      </div>
    </div>
  );
}

function Douyin({ model, locale }: { model: PreviewModel; locale: Locale }) {
  const dots = model.images.visible.length;
  return (
    <div className="pp-dy">
      {model.coverUrl === null ? (
        <span className="pp-cover__empty pp-dy__empty">{translate(locale, 'library.noCover')}</span>
      ) : (
        <img className="pp-dy__bg" src={model.coverUrl} alt="" draggable={false} />
      )}
      <div className="pp-dy__shade" aria-hidden="true" />
      <div className="pp-dy__rail" aria-hidden="true">
        <span className="pp-avatar pp-avatar--ring" />
        <span className="pp-dy__icon" />
        <span className="pp-dy__icon" />
        <span className="pp-dy__icon" />
      </div>
      <div className="pp-dy__caption">
        <span className="pp-dy__author">@{model.author}</span>
        <span className="pp-clamp" style={{ WebkitLineClamp: 3 }}>
          {model.title.shown} {model.tags.line}
        </span>
        {dots > 1 && (
          <span className="pp-dy__dots" aria-hidden="true">
            {model.images.visible.map((u, i) => (
              <span
                key={`${u}:${String(i)}`}
                className={i === 0 ? 'pp-dot pp-dot--on' : 'pp-dot'}
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function Channels({ model, locale }: { model: PreviewModel; locale: Locale }) {
  return (
    <div className="pp-sph">
      <div className="pp-sph__author">
        <span className="pp-avatar pp-avatar--square" aria-hidden="true" />
        <span className="pp-link pp-sph__name">{model.author}</span>
      </div>
      <div className="pp-clamp pp-sph__text" style={{ WebkitLineClamp: 3 }}>
        {model.title.shown} {model.tags.line}
      </div>
      <div className="pp-sph__media">
        <Cover url={model.coverUrl} ratio={model.template.coverAspectRatio} locale={locale}>
          <Counter model={model} />
        </Cover>
      </div>
      {model.dateLabel !== '' && <div className="pp-meta">{model.dateLabel}</div>}
    </div>
  );
}

/** A phone-framed simulation of one platform variant. */
export function PlatformPreview({
  model,
  empty,
  locale,
}: {
  model: PreviewModel | null;
  empty?: string;
  locale: Locale;
}) {
  const emptyText = empty ?? translate(locale, 'library.noVersion');
  return (
    <div
      className="pp-phone"
      role="img"
      aria-label={
        model === null
          ? translate(locale, 'library.previewAriaEmpty', { text: emptyText })
          : translate(locale, 'library.previewAria', {
              platform: translate(locale, PLATFORM_NAME_KEY[model.platform]),
              title: model.title.shown,
            })
      }
    >
      <div className="pp-screen">
        <span className="pp-sim">{translate(locale, 'library.simulated')}</span>
        {model === null ? (
          <div className="pp-empty">{emptyText}</div>
        ) : model.platform === 'xiaohongshu' ? (
          <Xiaohongshu model={model} locale={locale} />
        ) : model.platform === 'wechat_mp' ? (
          <WechatArticle model={model} locale={locale} />
        ) : model.platform === 'douyin' ? (
          <Douyin model={model} locale={locale} />
        ) : (
          <Channels model={model} locale={locale} />
        )}
      </div>
    </div>
  );
}
