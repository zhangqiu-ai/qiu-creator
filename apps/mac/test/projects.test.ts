import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Project } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performProxyRequest } from '../src/main/proxy.js';
import { bridgeFetch } from '../src/renderer/api.js';
import { filterProjects } from '../src/renderer/ProjectTags.js';
import { addToProject, type Notice } from '../src/renderer/project-actions.js';
import { dropAnimationFor, dropIntoKeyframes, sortTransition } from '../src/renderer/dnd-motion.js';
import { dropAction } from '../src/renderer/projects-dnd.js';
import {
  membership,
  moveInOrder,
  nextProjectColor,
  projectColor,
  projectLabel,
  projectName,
  ProjectsStore,
} from '../src/renderer/projects-store.js';

const TOKEN = 'qc-062-token';

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    color: 0,
    sort_order: 0,
    revision: 1,
    archived: false,
    archived_at: null,
    deleted_at: null,
    work_count: 0,
    created_at: '2026-11-21T00:00:00.000Z',
    updated_at: '2026-11-21T00:00:00.000Z',
    ...extra,
  };
}

describe('project helpers (QC-062)', () => {
  it('tri-state membership over the chosen works', () => {
    const works = [{ project_ids: ['a'] }, { project_ids: ['a', 'b'] }, {}];
    expect(membership(works, 'a')).toBe('some');
    expect(membership(works.slice(0, 2), 'a')).toBe('all');
    expect(membership(works, 'c')).toBe('none');
    expect(membership([], 'a')).toBe('none');
  });

  it('card label names the first other live project, then +N (QC-069)', () => {
    const list = [
      project('a'),
      project('b'),
      project('c', { archived: true }),
      project('d'),
      project('e'),
    ];
    expect(projectLabel(['a', 'b', 'c', 'd', 'e'], list, 'a')).toEqual({
      first: list[1],
      others: [list[3], list[4]],
    });
    // On its own project page, a work in no other project shows no label.
    expect(projectLabel(['a'], list, 'a')).toBeNull();
    expect(projectLabel(['c'], list, null)).toBeNull();
    expect(projectLabel(undefined, list, null)).toBeNull();
    // A project the list does not know (deleted) is not shown.
    expect(projectLabel(['zz', 'd'], list, null)?.first.id).toBe('d');
  });

  it('new projects take the eight colours in turn (QC-069)', () => {
    expect(nextProjectColor([])).toBe(0);
    expect(nextProjectColor([project('a'), project('b'), project('c')])).toBe(3);
    const eight = Array.from({ length: 8 }, (_, i) => project(`p${String(i)}`));
    expect(nextProjectColor(eight)).toBe(0);
    expect(nextProjectColor([...eight, project('x')])).toBe(1);
  });

  it('moves with ⌥↑/⌥↓ in the sidebar order', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(moveInOrder(ids, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveInOrder(ids, 'c', 1)).toEqual(['a', 'b', 'd', 'c']);
    expect(moveInOrder(ids, 'a', -1)).toEqual(ids);
    expect(moveInOrder(ids, 'd', 1)).toEqual(ids);
  });

  it('a drop adds works to a live project or reorders rows, nothing else', () => {
    const a = project('a');
    const b = project('b');
    const c = project('c');
    const old = project('old', { archived: true });
    const order = [a, b, old, c];
    const works = [{ id: 'w1', title: '一', project_ids: [] }];
    const on = (p: Project) => ({ type: 'project', project: p });
    expect(dropAction({ type: 'works', works }, on(b), order)).toEqual({
      kind: 'add',
      project: b,
      works,
    });
    // Archived projects and 未分類 (no drop data) take no drops; empty drags do nothing.
    expect(dropAction({ type: 'works', works }, on(old), order)).toBeNull();
    expect(dropAction({ type: 'works', works }, undefined, order)).toBeNull();
    expect(dropAction({ type: 'works', works: [] }, on(b), order)).toBeNull();
    // Rows: live ones in their new order, archived ones after them.
    expect(dropAction(on(a), on(c), order)).toEqual({
      kind: 'reorder',
      ids: ['b', 'c', 'a', 'old'],
    });
    expect(dropAction(on(c), on(a), order)).toEqual({
      kind: 'reorder',
      ids: ['c', 'a', 'b', 'old'],
    });
    expect(dropAction(on(a), on(a), order)).toBeNull();
    // A project row dropped on a work card (not a drop target) or junk data.
    expect(dropAction(on(a), { type: 'works', works }, order)).toBeNull();
    expect(dropAction({ nope: 1 }, on(a), order)).toBeNull();
  });

  it('drop animations follow DESIGN.md 動效 · 拖放, and stop without full motion', () => {
    for (const landing of ['into', 'sort', 'cancel'] as const) {
      expect(dropAnimationFor(landing, 'off')).toBeNull();
      expect(dropAnimationFor(landing, 'reduced')).toBeNull();
    }
    const cancel = dropAnimationFor('cancel', 'full');
    expect(cancel?.duration).toBe(240);
    expect(cancel?.easing).toBe('cubic-bezier(0.45, 0, 0.25, 1)');
    expect(dropAnimationFor('sort', 'full')?.duration).toBe(180);
    const into = dropAnimationFor('into', 'full');
    expect(into?.duration).toBe(180);
    expect(into?.keyframes).toBeDefined();
    const frames = dropIntoKeyframes({ x: 10, y: 20, scaleX: 1, scaleY: 1 });
    expect(frames.at(-1)).toEqual({
      opacity: 0,
      transform: 'translate3d(10px, 20px, 0) scaleX(0.6) scaleY(0.6)',
    });
    expect(sortTransition('full')).toEqual({
      duration: 180,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
    expect(sortTransition('reduced')).toBeNull();
    expect(sortTransition('off')).toBeNull();
  });

  it('names are trimmed and within 60 characters; colours fall back to the first', () => {
    expect(projectName('  春季選題 ')).toBe('春季選題');
    expect(projectName('   ')).toBeNull();
    expect(projectName('字'.repeat(60))).toBe('字'.repeat(60));
    expect(projectName('字'.repeat(61))).toBeNull();
    expect(projectColor(3)).toBe('#4C8A3F');
    expect(projectColor(42)).toBe('#5B6B7F');
  });

  it('the editor search offers 新建 only for a new name', () => {
    const list = [
      project('p1', { name: '春季選題' }),
      project('p2', { name: '舊案', archived: true }),
    ];
    expect(filterProjects(list, '').matches.map((p) => p.id)).toEqual(['p1']);
    expect(filterProjects(list, '春季')).toEqual({ matches: [list[0]], canCreate: true });
    expect(filterProjects(list, '春季選題').canCreate).toBe(false);
    expect(filterProjects(list, '  ').canCreate).toBe(false);
  });
});

describe('ProjectsStore against the service (QC-062)', () => {
  let home: string;
  let server: CreatorHubServer;
  let client: CreatorHubClient;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-062-'));
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

  it('loads projects with the 全部 and 未分類 counts', async () => {
    const store = new ProjectsStore(client);
    await client.works.create({ title: 'A', markdown: '', source: 'mac-app' });
    const p = await client.projects.create({ name: '春季' });
    await client.works.create({ title: 'B', markdown: '', source: 'mac-app', project_ids: [p.id] });
    await store.load();
    const s = store.getSnapshot();
    expect(s.projects?.map((x) => x.name)).toEqual(['春季']);
    expect(s.projects?.[0]?.work_count).toBe(1);
    expect(s.allCount).toBe(2);
    expect(s.unassignedCount).toBe(1);
    expect(s.failed).toBe(false);
  });

  it('adds only what is new, and undo takes back exactly those', async () => {
    const store = new ProjectsStore(client);
    const p = await store.create('夏季');
    const w1 = await client.works.create({
      title: '1',
      markdown: '',
      source: 'mac-app',
      project_ids: [p.id],
    });
    const w2 = await client.works.create({ title: '2', markdown: '', source: 'mac-app' });
    await store.load();
    const notices: Notice[] = [];
    const notify = (n: Notice | null) => {
      if (n !== null) notices.push(n);
    };
    const fresh = store.find(p.id);
    expect(fresh).not.toBeNull();
    if (fresh === null) return;
    await addToProject(store, fresh, [w1, w2], notify);
    expect((await client.works.list({ project_id: p.id })).total).toBe(2);
    expect(notices.at(-1)?.message).toContain('夏季');
    await notices.at(-1)?.undo?.();
    const left = await client.works.list({ project_id: p.id });
    // w1 was in it before, so undo leaves it there.
    expect(left.items.map((w) => w.id)).toEqual([w1.id]);
    // Nothing new to add: a notice, no request.
    await addToProject(store, fresh, [{ ...w1, project_ids: [p.id] }], notify);
    expect(notices.at(-1)?.undo).toBeUndefined();
  });

  it('a stale rename is refused and the list read again', async () => {
    const store = new ProjectsStore(client);
    const p = await store.create('秋季');
    const stale = store.find(p.id);
    await client.projects.patch(p.id, { base_revision: p.revision, name: '秋季二' });
    expect(stale).not.toBeNull();
    if (stale === null) return;
    expect(await store.patch(stale, { name: '秋季三' })).toBeNull();
    expect(store.find(p.id)?.name).toBe('秋季二');
  });

  it('reorders, deletes and restores', async () => {
    const store = new ProjectsStore(client);
    const a = await store.create('A');
    const b = await store.create('B');
    await store.reorder([b.id, a.id]);
    expect(store.order).toEqual([b.id, a.id]);
    await store.remove(a.id);
    expect(store.order).toEqual([b.id]);
    await store.restore(a.id);
    expect(store.order.sort()).toEqual([a.id, b.id].sort());
  });
});
