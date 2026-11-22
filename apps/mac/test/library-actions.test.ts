import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performProxyRequest } from '../src/main/proxy.js';
import { placeMenu } from '../src/renderer/ContextMenu.js';
import { bridgeFetch } from '../src/renderer/api.js';
import {
  clickSelect,
  contextTargets,
  EMPTY_SELECTION,
  keepShown,
  renameKey,
  renameTitle,
  selectAll,
} from '../src/renderer/library-select.js';
import { sessionHandle } from '../src/renderer/tab-handle.js';
import { TabsModel } from '../src/renderer/tabs.js';
import {
  daysLeft,
  parseTags,
  summarize,
  tagUndoGroups,
  unionTags,
} from '../src/renderer/library-trash.js';
import {
  batchWorks,
  changeWork,
  freshRevisions,
  purgeWorks,
  restoreWorks,
  trashWorks,
  type EditorHandles,
} from '../src/renderer/work-actions.js';
import { WorkSession } from '../src/renderer/work-session.js';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const plain = { meta: false, shift: false };
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

describe('library selection (QC-052)', () => {
  it('a plain click selects one; ⌘ adds and removes', () => {
    let s = clickSelect(EMPTY_SELECTION, 'b', ORDER, plain);
    expect(ids(s)).toEqual(['b']);
    s = clickSelect(s, 'd', ORDER, { meta: true, shift: false });
    expect(ids(s)).toEqual(['b', 'd']);
    s = clickSelect(s, 'b', ORDER, { meta: true, shift: false });
    expect(ids(s)).toEqual(['d']);
    expect(clickSelect(s, 'a', ORDER, plain).ids).toEqual(new Set(['a']));
  });

  it('⇧ selects the range from the anchor, in either direction; ⌘⇧ adds it', () => {
    const s = clickSelect(EMPTY_SELECTION, 'b', ORDER, plain);
    expect(ids(clickSelect(s, 'd', ORDER, { meta: false, shift: true }))).toEqual(['b', 'c', 'd']);
    const back = clickSelect(clickSelect(EMPTY_SELECTION, 'd', ORDER, plain), 'a', ORDER, {
      meta: false,
      shift: true,
    });
    expect(ids(back)).toEqual(['a', 'b', 'c', 'd']);
    // The anchor stays, so a second ⇧ click re-draws the range instead of growing it.
    const again = clickSelect(back, 'e', ORDER, { meta: false, shift: true });
    expect(ids(again)).toEqual(['d', 'e']);
    const withE = clickSelect(clickSelect(EMPTY_SELECTION, 'a', ORDER, plain), 'e', ORDER, {
      meta: true,
      shift: false,
    });
    expect(ids(clickSelect(withE, 'c', ORDER, { meta: true, shift: true }))).toEqual([
      'a',
      'c',
      'd',
      'e',
    ]);
  });

  it('⇧ with no anchor acts like ⌘', () => {
    expect(ids(clickSelect(EMPTY_SELECTION, 'c', ORDER, { meta: false, shift: true }))).toEqual([
      'c',
    ]);
  });

  it('⌘A selects all shown; filtering drops what is no longer shown', () => {
    const all = selectAll(ORDER);
    expect(ids(all)).toEqual(ORDER);
    const kept = keepShown(all, ['b', 'c']);
    expect(ids(kept)).toEqual(['b', 'c']);
    expect(kept.anchor).toBeNull();
    // Unchanged selections keep their identity, so React does not re-render for nothing.
    expect(keepShown(kept, ['b', 'c', 'z'])).toBe(kept);
  });

  it('right-click acts on the selection only when the work is part of it', () => {
    const sel = selectAll(['a', 'b', 'c']);
    expect(contextTargets(sel, 'c', ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
    expect(contextTargets(sel, 'z', ORDER)).toEqual(['z']);
  });
});

describe('rename field keys (QC-052)', () => {
  it('↩ while the IME composes does not commit', () => {
    expect(renameKey({ key: 'Enter', isComposing: true })).toBeNull();
    expect(renameKey({ key: 'Process', isComposing: false })).toBeNull();
    expect(renameKey({ key: 'Escape', isComposing: true })).toBeNull();
    expect(renameKey({ key: 'Enter', isComposing: false })).toBe('commit');
    expect(renameKey({ key: 'Escape', isComposing: false })).toBe('cancel');
    expect(renameKey({ key: 'a', isComposing: false })).toBeNull();
  });

  it('a blank or unchanged name sends nothing; names are trimmed', () => {
    expect(renameTitle('舊名', '   ')).toBeNull();
    expect(renameTitle('舊名', ' 舊名 ')).toBeNull();
    expect(renameTitle('舊名', '  新名 ')).toBe('新名');
    expect(renameTitle('a', 'x'.repeat(600))).toHaveLength(500);
  });
});

describe('context menu placement', () => {
  const view = { width: 1000, height: 700 };
  it('opens at the pointer and flips or shifts to stay on screen', () => {
    expect(placeMenu({ x: 100, y: 100 }, { width: 200, height: 300 }, view)).toEqual({
      left: 100,
      top: 100,
    });
    expect(placeMenu({ x: 900, y: 600 }, { width: 200, height: 300 }, view)).toEqual({
      left: 700,
      top: 392,
    });
    // A submenu flips to the left of its parent menu.
    expect(placeMenu({ x: 902, y: 10 }, { width: 200, height: 100 }, view, 224)).toEqual({
      left: 478,
      top: 10,
    });
  });
});

describe('TabsModel.openInBackground (在新分頁開啟)', () => {
  it('adds an unloaded tab behind the active one, and nothing if already open', () => {
    const m = new TabsModel();
    m.open({ id: 'a', kind: 'article', title: 'A' });
    expect(m.openInBackground({ id: 'b', kind: 'image', title: 'B' })).toBe('opened');
    expect(m.active?.id).toBe('a');
    expect(m.find('b')).toMatchObject({ loaded: false, title: 'B' });
    expect(m.openInBackground({ id: 'b', kind: 'image', title: 'B' })).toBe('exists');
    expect(m.tabs).toHaveLength(2);
  });

  it('with no tab open it becomes the active tab', () => {
    const m = new TabsModel();
    m.openInBackground({ id: 'a', kind: 'article', title: 'A' });
    expect(m.active?.id).toBe('a');
    expect(m.find('a')?.loaded).toBe(true);
  });
});

describe('回收站 and batch helpers (QC-052)', () => {
  it('days left until a deleted work is purged', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    expect(daysLeft('2026-12-21T00:00:00Z', now)).toBe(30);
    expect(daysLeft('2026-11-22T12:00:00Z', now)).toBe(2);
    expect(daysLeft('2026-11-21T08:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-11-20T00:00:00Z', now)).toBe(0);
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft('not a date', now)).toBeNull();
  });

  it('parses typed tags: commas, 、, spaces and # split; duplicates dropped', () => {
    expect(parseTags(' 旅行，京都、 #秋天  旅行 ,, ')).toEqual(['旅行', '京都', '秋天']);
    expect(parseTags('   ')).toEqual([]);
    expect(parseTags('x'.repeat(80))[0]).toHaveLength(64);
  });

  it('lists the tags a selection has, and undoes only what each work really changed', () => {
    const before = [
      { id: 'a', tags: ['旅行'] },
      { id: 'b', tags: [] },
      { id: 'c', tags: ['旅行', '京都'] },
    ];
    expect(unionTags(before)).toEqual(['旅行', '京都']);
    // Adding 旅行 + 京都: a gains 京都 only, b gains both, c gains nothing.
    expect(tagUndoGroups(before, ['旅行', '京都'], 'add')).toEqual([
      { tags: ['京都'], ids: ['a'] },
      { tags: ['旅行', '京都'], ids: ['b'] },
    ]);
    // Removing 旅行: a and c lose it, b never had it.
    expect(tagUndoGroups(before, ['旅行'], 'remove')).toEqual([
      { tags: ['旅行'], ids: ['a', 'c'] },
    ]);
  });

  it('splits batch results into changed works and failures with their codes', () => {
    const s = summarize([
      { id: 'x', ok: false, error: { code: 'revision_conflict', message: 'm' } },
    ]);
    expect(s).toEqual({ ok: [], failed: [{ id: 'x', code: 'revision_conflict' }] });
  });
});

// ---- Against a real mac-server in a throwaway CREATORHUB_HOME ----

const TOKEN = 'test-token-0123456789abcdef';
let server: CreatorHubServer;
let home: string;
let client: CreatorHubClient;

describe('changeWork: rename and status from 作品庫 and the tab bar', () => {
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-052-'));
    server = await buildServer({ config: { home, token: TOKEN } });
    const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
    client = createClient({
      baseUrl,
      token: TOKEN,
      fetch: bridgeFetch((req) => performProxyRequest(baseUrl, req)),
    });
  });
  afterEach(async () => {
    await server.app.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('renames each kind of work against the revision the list showed', async () => {
    const handles: EditorHandles = new Map();
    const article = await client.works.create({
      title: '舊文章',
      markdown: '正文',
      source: 'mac-app',
    });
    const post = await client.works.create({ title: '舊貼圖', type: 'image', source: 'mac-app' });
    const video = await client.works.create({ title: '舊視頻', type: 'video', source: 'mac-app' });
    for (const [work, title] of [
      [article, '新文章'],
      [post, '新貼圖'],
      [video, '新視頻'],
    ] as const) {
      const r = await changeWork(client, work, { title }, handles);
      expect(r.outcome).toBe('saved');
      expect(r.work?.title).toBe(title);
      expect((await client.works.get(work.id)).title).toBe(title);
    }
    const list = await client.works.list({ limit: 10 });
    expect(list.items.map((w) => w.title).sort()).toEqual(['新文章', '新視頻', '新貼圖']);
  });

  it('answers conflict, and writes nothing, when the work changed since the list was read', async () => {
    const listed = await client.works.create({ title: '原名', markdown: 'a', source: 'mac-app' });
    await client.works.patch(listed.id, {
      base_revision: listed.current_revision_id,
      markdown: '別處的修改',
    });
    const r = await changeWork(client, listed, { title: '新名' }, new Map());
    expect(r.outcome).toBe('conflict');
    const now = await client.works.get(listed.id);
    expect(now.title).toBe('原名');
    expect(now.markdown).toContain('別處的修改');
  });

  it('a work open in a tab changes through its editor session, keeping its unsaved edits', async () => {
    const work = await client.works.create({ title: '開著的', markdown: '一', source: 'mac-app' });
    const session = new WorkSession(client, work);
    const handles: EditorHandles = new Map([
      [
        work.id,
        sessionHandle(session, () => {
          // not discarded in this test
        }),
      ],
    ]);
    // An edit the editor has not saved yet.
    session.edit({ markdown: '一二' });
    // The list's revision is stale for the session's coming save, but the handle route never uses it.
    const r = await changeWork(client, work, { title: '改過的' }, handles);
    expect(r.outcome).toBe('saved');
    expect(session.snapshot.status).toBe('saved');
    const now = await client.works.get(work.id);
    expect(now.title).toBe('改過的');
    expect(now.markdown).toContain('一二');

    const s = await changeWork(client, now, { status: 'ready' }, handles);
    expect(s.outcome).toBe('saved');
    expect((await client.works.get(work.id)).status).toBe('ready');
    session.dispose();
  });

  it('a read-only (missing) work in a tab refuses to change', async () => {
    const work = await client.works.create({ title: 'x', markdown: '', source: 'mac-app' });
    const session = new WorkSession(client, { ...work, external_state: 'missing' });
    const handle = sessionHandle(session, () => undefined);
    expect(await handle.change({ title: 'y' })).toBe('failed');
    expect((await client.works.get(work.id)).title).toBe('x');
    session.dispose();
  });

  it('deletes one work to 回收站 and restores it with the same revision', async () => {
    const work = await client.works.create({
      title: '要刪的',
      markdown: '內容',
      source: 'mac-app',
    });
    const out = await trashWorks(client, [work]);
    expect(out.failed).toEqual([]);
    expect(out.ok[0]?.deleted_at).toBeTruthy();
    expect((await client.works.list({ limit: 10 })).items).toHaveLength(0);
    const trash = await client.works.list({ scope: 'trash', limit: 10 });
    expect(trash.items.map((w) => w.id)).toEqual([work.id]);
    expect(trash.items[0]?.purge_at).toBeTruthy();

    const back = await restoreWorks(client, out.ok);
    expect(back.failed).toEqual([]);
    const now = await client.works.get(work.id);
    expect(now.current_revision_id).toBe(work.current_revision_id);
    expect(now.markdown).toContain('內容');
    expect((await client.works.list({ scope: 'trash', limit: 10 })).total).toBe(0);
  });

  it('a stale revision is not deleted; the others in the batch are', async () => {
    const a = await client.works.create({ title: 'A', markdown: '', source: 'mac-app' });
    const b = await client.works.create({ title: 'B', markdown: '', source: 'mac-app' });
    await client.works.patch(b.id, { base_revision: b.current_revision_id, markdown: '別處' });
    const out = await trashWorks(client, [a, b]);
    expect(out.ok.map((w) => w.id)).toEqual([a.id]);
    expect(out.failed).toEqual([{ id: b.id, code: 'revision_conflict' }]);
    expect((await client.works.list({ limit: 10 })).items.map((w) => w.title)).toEqual(['B']);
  });

  it('purges works in 回收站 one by one and reports what was not there', async () => {
    const a = await client.works.create({ title: 'A', markdown: '', source: 'mac-app' });
    const b = await client.works.create({ title: 'B', markdown: '', source: 'mac-app' });
    await trashWorks(client, [a]);
    const out = await purgeWorks(client, [a.id, b.id]);
    expect(out.purged).toEqual([a.id]);
    expect(out.failed).toEqual([{ id: b.id, code: 'not_found' }]);
    expect((await client.works.list({ scope: 'trash', limit: 10 })).total).toBe(0);
    await expect(client.works.get(a.id)).rejects.toThrow();
  });

  it('batch status and tags write new revisions; an open editor is saved first and keeps its edit', async () => {
    const open = await client.works.create({ title: '開著', markdown: '一', source: 'mac-app' });
    const other = await client.works.create({ title: '沒開', markdown: '', source: 'mac-app' });
    const session = new WorkSession(client, open);
    const handles: EditorHandles = new Map([[open.id, sessionHandle(session, () => undefined)]]);
    session.edit({ markdown: '一二三' });

    const ready = await freshRevisions(client, [open, other], handles);
    expect(ready[0]?.current_revision_id).not.toBe(open.current_revision_id);
    const status = await batchWorks(client, { action: 'set_status', status: 'ready' }, ready);
    expect(status.failed).toEqual([]);
    const tagged = await batchWorks(
      client,
      { action: 'add_tags', tags: ['京都'] },
      status.ok.map((w) => ({ id: w.id, current_revision_id: w.current_revision_id })),
    );
    expect(tagged.failed).toEqual([]);
    const now = await client.works.get(open.id);
    expect(now).toMatchObject({ status: 'ready', tags: ['京都'] });
    expect(now.markdown).toContain('一二三');
    expect((await client.works.get(other.id)).tags).toEqual(['京都']);
    session.dispose();
  });

  it('status changes can be undone against the new revision', async () => {
    const work = await client.works.create({ title: '狀態', markdown: '', source: 'mac-app' });
    const changed = await changeWork(client, work, { status: 'in_review' }, new Map());
    expect(changed.work?.status).toBe('in_review');
    const back = changed.work;
    if (back === null) throw new Error('no work');
    const undone = await changeWork(client, back, { status: work.status }, new Map());
    expect(undone.outcome).toBe('saved');
    expect((await client.works.get(work.id)).status).toBe(work.status);
  });
});
