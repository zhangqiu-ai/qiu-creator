import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { ChangeEvent, ProjectGroup } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performProxyRequest } from '../src/main/proxy.js';
import { bridgeFetch } from '../src/renderer/api.js';
import type { MenuEntry } from '../src/renderer/ContextMenu.js';
import {
  episodeItems,
  groupMenuItems,
  groupName,
  moveToGroupMenu,
} from '../src/renderer/ProjectGroups.js';
import {
  assignLocally,
  dropChanges,
  episodeOf,
  groupOfWork,
  insertionIndex,
  moveLocally,
  nextEpisode,
  positionAt,
  readCollapsed,
  sectionWorks,
  UNGROUPED,
  workGroupIn,
  writeCollapsed,
} from '../src/renderer/project-groups.js';
import { dropAction, isGroupTarget } from '../src/renderer/projects-dnd.js';
import { ProjectGroupsStore, type ProjectGroupsApi } from '../src/renderer/use-project-groups.js';

/* QC-114: groups and series on a project page (PT-20261126-002 option A). */

function group(id: string, workIds: string[], extra: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    project_id: 'p1',
    name: id,
    ordered: false,
    sort_order: 0,
    revision: 1,
    created_by: { kind: 'user', token_id: null, token_name: null },
    created_at: '2026-11-27T00:00:00.000Z',
    updated_at: '2026-11-27T00:00:00.000Z',
    work_count: workIds.length,
    work_ids: workIds,
    ...extra,
  };
}

const w = (id: string) => ({ id });
const ids = (list: readonly { id: string }[]) => list.map((x) => x.id);

describe('sectionWorks', () => {
  const kyoto = group('kyoto', ['k1', 'k2', 'k3'], { ordered: true, sort_order: 0 });
  const gear = group('gear', ['g1', 'g2'], { sort_order: 1 });
  const empty = group('empty', [], { sort_order: 2 });
  // The page order (newest first): a series is re-ordered by episode, other groups keep it.
  const works = ['u1', 'k3', 'g2', 'k1', 'u2', 'g1', 'k2'].map(w);

  it('puts 未分組 first, then groups in order; a series by episode', () => {
    const s = sectionWorks(works, [empty, gear, kyoto], { filtering: false, total: 7 });
    expect(s.map((x) => x.key)).toEqual([UNGROUPED, 'kyoto', 'gear', 'empty']);
    expect(ids(s[0]?.works ?? [])).toEqual(['u1', 'u2']);
    expect(ids(s[1]?.works ?? [])).toEqual(['k1', 'k2', 'k3']);
    expect(ids(s[2]?.works ?? [])).toEqual(['g2', 'g1']);
    expect(s[3]?.works).toEqual([]);
    expect(s.map((x) => x.count)).toEqual([2, 3, 2, 0]);
  });

  it('shows 未分組 only when it has works, counting those not loaded yet', () => {
    const grouped = ['k1', 'k2', 'k3', 'g1', 'g2'].map(w);
    expect(
      sectionWorks(grouped, [kyoto, gear], { filtering: false, total: 5 }).map((x) => x.key),
    ).toEqual(['kyoto', 'gear']);
    // Two more works in the project than in its groups, not loaded yet.
    const s = sectionWorks(grouped, [kyoto, gear], { filtering: false, total: 7 });
    expect(s[0]?.key).toBe(UNGROUPED);
    expect(s[0]?.count).toBe(2);
  });

  it('with a filter on, counts what it shows and hides groups with nothing to show', () => {
    const s = sectionWorks(['k2', 'u1'].map(w), [kyoto, gear, empty], {
      filtering: true,
      total: 2,
    });
    expect(s.map((x) => [x.key, x.count])).toEqual([
      [UNGROUPED, 1],
      ['kyoto', 1],
    ]);
  });
});

describe('episodes and local moves', () => {
  const series = group('s', ['a', 'b', 'c', 'd'], { ordered: true });
  const plain = group('p', ['x', 'y'], { sort_order: 1 });

  it('numbers episodes only in a series', () => {
    expect(episodeOf(series, 'c')).toBe(3);
    expect(episodeOf(series, 'zz')).toBeNull();
    expect(episodeOf(plain, 'x')).toBeNull();
    expect(episodeOf(null, 'x')).toBeNull();
    expect(groupOfWork([series, plain], 'y')?.id).toBe('p');
    expect(groupOfWork([series, plain], 'u')).toBeNull();
  });

  it('moves works as the service does: out of their group, into the target at a place', () => {
    const [s1, p1] = assignLocally([series, plain], ['x'], 's', 2);
    expect(s1?.work_ids).toEqual(['a', 'x', 'b', 'c', 'd']);
    expect(s1?.work_count).toBe(5);
    expect(p1?.work_ids).toEqual(['y']);
    // Inside a series: the place counts the others only (a to episode 3 → b c a d).
    expect(assignLocally([series], ['a'], 's', 3)[0]?.work_ids).toEqual(['b', 'c', 'a', 'd']);
    // Without a place, at the end; to 未分組, out of every group.
    expect(assignLocally([series, plain], ['b'], 'p')[1]?.work_ids).toEqual(['x', 'y', 'b']);
    expect(assignLocally([series, plain], ['b', 'x'], null).map((g) => g.work_ids)).toEqual([
      ['a', 'c', 'd'],
      ['y'],
    ]);
  });

  it('reorders groups (上移／下移, dragging a header)', () => {
    const g = [group('a', [], { sort_order: 0 }), group('b', [], { sort_order: 1 }), plain];
    g[2] = { ...plain, id: 'c', sort_order: 2 };
    const moved = moveLocally(g, 'c', 0);
    expect([...moved].sort((x, y) => x.sort_order - y.sort_order).map((x) => x.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(moveLocally(g, 'a', 9).map((x) => [x.id, x.sort_order])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('knows when a drop changes nothing', () => {
    expect(dropChanges([series, plain], ['x'], 'p')).toBe(false);
    expect(dropChanges([series, plain], ['x'], 's')).toBe(true);
    expect(dropChanges([series, plain], ['u'], null)).toBe(false);
    expect(dropChanges([series, plain], ['x'], null)).toBe(true);
    // In a series a new place is a change; the same place is not.
    expect(dropChanges([series], ['a'], 's', 3)).toBe(true);
    expect(dropChanges([series], ['a'], 's', 1)).toBe(false);
    expect(dropChanges([series], [], 's')).toBe(false);
    expect(nextEpisode(series, ['b'])).toBe(4);
    expect(nextEpisode(series, ['z'])).toBe(5);
  });
});

describe('insertion line', () => {
  // Two rows of three 100×80 cards with 12 px gaps.
  const grid = [0, 1, 2, 3, 4, 5].map((i) => ({
    left: (i % 3) * 112,
    top: Math.floor(i / 3) * 92,
    width: 100,
    height: 80,
  }));

  it('in a grid: before the card whose left half (or row above) the pointer is in', () => {
    expect(insertionIndex({ x: 10, y: 40 }, grid, 'grid')).toBe(0);
    expect(insertionIndex({ x: 80, y: 40 }, grid, 'grid')).toBe(1);
    expect(insertionIndex({ x: 330, y: 40 }, grid, 'grid')).toBe(3);
    expect(insertionIndex({ x: 130, y: 120 }, grid, 'grid')).toBe(4);
    expect(insertionIndex({ x: 400, y: 120 }, grid, 'grid')).toBe(6);
    // In the gap between rows: before the next row.
    expect(insertionIndex({ x: 300, y: 86 }, grid, 'grid')).toBe(3);
  });

  it('in a list: above a row’s middle', () => {
    const rows = [0, 1, 2].map((i) => ({ left: 0, top: i * 40, width: 600, height: 40 }));
    expect(insertionIndex({ x: 300, y: 10 }, rows, 'list')).toBe(0);
    expect(insertionIndex({ x: 300, y: 30 }, rows, 'list')).toBe(1);
    expect(insertionIndex({ x: 300, y: 119 }, rows, 'list')).toBe(3);
    expect(insertionIndex({ x: 0, y: 0 }, [], 'list')).toBe(0);
  });

  it('turns an index among shown works into the service’s place among the others', () => {
    const shown = ['a', 'b', 'c', 'd'];
    expect(positionAt(shown, 0, ['c'])).toBe(1);
    expect(positionAt(shown, 4, ['a'])).toBe(4);
    expect(positionAt(shown, 3, ['a'])).toBe(3);
    expect(positionAt(shown, 2, ['x', 'y'])).toBe(3);
  });
});

describe('remembered collapse', () => {
  let store: Map<string, string>;
  let before: unknown;
  const g = globalThis as { localStorage?: unknown };
  beforeEach(() => {
    store = new Map();
    before = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
  });
  afterEach(() => {
    g.localStorage = before;
  });

  it('keeps each project’s collapsed sections apart', () => {
    writeCollapsed('p1', new Set(['gear', UNGROUPED]));
    writeCollapsed('p2', new Set(['x']));
    expect([...readCollapsed('p1')].sort()).toEqual(['gear', UNGROUPED].sort());
    writeCollapsed('p1', new Set());
    expect(readCollapsed('p1').size).toBe(0);
    expect([...readCollapsed('p2')]).toEqual(['x']);
  });

  it('survives broken or missing storage', () => {
    store.set('qc.projectGroups.collapsed', '{oops');
    expect(readCollapsed('p1').size).toBe(0);
    g.localStorage = undefined;
    expect(readCollapsed('p1').size).toBe(0);
    expect(() => {
      writeCollapsed('p1', new Set(['a']));
    }).not.toThrow();
  });
});

describe('menus and labels', () => {
  const calls: unknown[][] = [];
  const api: ProjectGroupsApi = {
    groups: [],
    reload: () => undefined,
    create: () => Promise.resolve(null),
    rename: (g, name) => {
      calls.push(['rename', g.id, name]);
      return Promise.resolve(true);
    },
    setOrdered: (g, on) => {
      calls.push(['ordered', g.id, on]);
      return Promise.resolve(true);
    },
    move: (g, to) => {
      calls.push(['move', g.id, to]);
      return Promise.resolve(true);
    },
    remove: (g) => {
      calls.push(['remove', g.id]);
      return Promise.resolve(true);
    },
    assign: (workIds, groupId, position) => {
      calls.push(['assign', workIds, groupId, position]);
      return Promise.resolve(true);
    },
  };
  beforeEach(() => {
    calls.length = 0;
  });
  const items = (e: MenuEntry): MenuEntry[] => (e.kind === 'sub' ? [...e.items] : [e]);
  const pick = (list: readonly MenuEntry[], id: string) => {
    const e = list.find((x) => x.id === id);
    if (e?.kind !== 'item') throw new Error(`no item ${id}`);
    return e;
  };

  it('移到分組 ▸ checks where the works are, says a series episode, and offers a new group', () => {
    const series = group('s', ['a', 'b'], { ordered: true, name: '京都', sort_order: 1 });
    const plain = group('p', ['x'], { name: '器材', sort_order: 0 });
    let made = false;
    const menu = moveToGroupMenu({
      groups: [series, plain],
      workIds: ['x'],
      api,
      onNew: () => {
        made = true;
      },
    });
    const list = items(menu);
    expect(list.map((e) => e.id)).toEqual([
      'group-to-none',
      'group-to-p',
      'group-to-s',
      'group-to-sep',
      'group-to-new',
    ]);
    expect(pick(list, 'group-to-p').checked).toBe(true);
    expect(pick(list, 'group-to-none').checked).toBe(false);
    expect(pick(list, 'group-to-s').hint).toBe('放到第 3 集');
    pick(list, 'group-to-s').onSelect();
    pick(list, 'group-to-none').onSelect();
    pick(list, 'group-to-new').onSelect();
    expect(calls).toEqual([
      ['assign', ['x'], 's', undefined],
      ['assign', ['x'], null, undefined],
    ]);
    expect(made).toBe(true);
  });

  it('the group ⋯ menu moves up and down within bounds and toggles 系列', () => {
    const g = group('g', [], { name: 'A' });
    const first = groupMenuItems({
      group: g,
      index: 0,
      total: 3,
      api,
      onRename: () => undefined,
      onCollapseOthers: () => undefined,
      onDelete: () => undefined,
    });
    expect(pick(first, 'group-up').disabled).toBe(true);
    expect(pick(first, 'group-down').disabled).toBe(false);
    expect(pick(first, 'group-series').checkbox).toBe(false);
    pick(first, 'group-down').onSelect();
    pick(first, 'group-series').onSelect();
    expect(pick(first, 'group-delete').danger).toBe(true);
    const last = groupMenuItems({
      group: g,
      index: 2,
      total: 3,
      api,
      onRename: () => undefined,
      onCollapseOthers: () => undefined,
      onDelete: () => undefined,
    });
    expect(pick(last, 'group-down').disabled).toBe(true);
    expect(calls).toEqual([
      ['move', 'g', 1],
      ['ordered', 'g', true],
    ]);
  });

  it('往前一集／往後一集 renumber within a series only', () => {
    const series = group('s', ['a', 'b', 'c'], { ordered: true });
    expect(episodeItems(group('p', ['a']), 'a', api)).toEqual([]);
    const forB = episodeItems(series, 'b', api);
    pick(forB, 'episode-earlier').onSelect();
    pick(forB, 'episode-later').onSelect();
    expect(calls).toEqual([
      ['assign', ['b'], 's', 1],
      ['assign', ['b'], 's', 3],
    ]);
    expect(assignLocally([series], ['b'], 's', 1)[0]?.work_ids).toEqual(['b', 'a', 'c']);
    expect(assignLocally([series], ['b'], 's', 3)[0]?.work_ids).toEqual(['a', 'c', 'b']);
    expect(pick(episodeItems(series, 'a', api), 'episode-earlier').disabled).toBe(true);
    expect(pick(episodeItems(series, 'c', api), 'episode-later').disabled).toBe(true);
  });

  it('checks group names and finds a work’s group for 全部作品', () => {
    expect(groupName('  一人食 ')).toBe('一人食');
    expect(groupName('   ')).toBeNull();
    expect(groupName('字'.repeat(61))).toBeNull();
    expect(groupName('字'.repeat(60))).toBe('字'.repeat(60));
    const groups = [
      { project_id: 'p1', group_id: 'g', group_name: '京都', ordered: true, episode: 4 },
    ];
    expect(workGroupIn(groups, 'p1')).toEqual({ name: '京都', episode: 4 });
    expect(workGroupIn(groups, 'p2')).toBeNull();
    expect(workGroupIn(undefined, 'p1')).toBeNull();
  });
});

describe('drag data', () => {
  it('group targets are told apart, and project drops ignore group drags', () => {
    expect(isGroupTarget({ type: 'group-target', projectId: 'p', groupId: null, name: 'x' })).toBe(
      true,
    );
    expect(isGroupTarget({ type: 'project' })).toBe(false);
    expect(isGroupTarget(null)).toBe(false);
    const project = {
      id: 'p',
      name: 'p',
      color: 0,
      sort_order: 0,
      revision: 1,
      archived: false,
      archived_at: null,
      deleted_at: null,
      work_count: 0,
      created_at: '2026-11-27T00:00:00.000Z',
      updated_at: '2026-11-27T00:00:00.000Z',
    };
    expect(
      dropAction({ type: 'group', group: group('g', []) }, { type: 'project', project }, [project]),
    ).toBeNull();
  });
});

describe('ProjectGroupsStore against the service', () => {
  const TOKEN = 'qc-114-token';
  let home: string;
  let server: CreatorHubServer;
  let client: CreatorHubClient;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-114-'));
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

  async function seed() {
    const project = await client.projects.create({ name: '京都', color: 0 });
    const made = [];
    for (const title of ['a', 'b', 'c', 'd']) {
      made.push(
        await client.works.create({
          title,
          markdown: '',
          source: 'mac-app',
          project_ids: [project.id],
        }),
      );
    }
    return { project, ids: made.map((w) => w.id) };
  }

  it('creates, assigns (shown before the answer), renumbers a series and deletes', async () => {
    const { project, ids } = await seed();
    const errors: string[] = [];
    let assigned = 0;
    const store = new ProjectGroupsStore(client, {
      onError: (m) => errors.push(m),
      onAssigned: () => {
        assigned += 1;
      },
    });
    await store.open(project.id);
    expect(store.getSnapshot()).toEqual([]);
    const series = await store.create('系列', true);
    if (series === null) throw new Error('not created');
    const [a, b, c, d] = ids as [string, string, string, string];

    const pending = store.assign([a, b, c], series.id);
    // Optimistic: on the page before the service answers.
    expect(store.getSnapshot()?.[0]?.work_ids).toEqual([a, b, c]);
    expect(await pending).toBe(true);
    // c becomes episode 1; d joins as episode 3.
    await store.assign([c], series.id, 1);
    await store.assign([d], series.id, 3);
    const read = (await client.projects.get(project.id)).groups?.[0];
    expect(read?.work_ids).toEqual([c, a, d, b]);
    expect(store.getSnapshot()?.[0]?.work_ids).toEqual([c, a, d, b]);
    expect(assigned).toBe(3);

    const plain = await store.create('器材', false);
    if (plain === null) throw new Error('not created');
    await store.move(plain, 0);
    expect(
      [...(store.getSnapshot() ?? [])]
        .sort((x, y) => x.sort_order - y.sort_order)
        .map((g) => g.name),
    ).toEqual(['器材', '系列']);

    expect(await store.remove(series)).toBe(true);
    expect(store.getSnapshot()?.map((g) => g.name)).toEqual(['器材']);
    expect((await client.projects.get(project.id)).groups?.[0]?.work_ids).toEqual([]);
    expect(errors).toEqual([]);
    store.dispose();
  });

  it('a group changed elsewhere is a 409: the reason is told and the groups read again', async () => {
    const { project } = await seed();
    const errors: string[] = [];
    const store = new ProjectGroupsStore(client, { onError: (m) => errors.push(m) });
    await store.open(project.id);
    const group = await store.create('舊名', false);
    if (group === null) throw new Error('not created');
    // Another device renames it: this page still holds the old revision.
    await client.projects.patchGroup(project.id, group.id, {
      base_revision: group.revision,
      name: '別處改的',
    });
    expect(await store.rename(group, '這裡改的')).toBe(false);
    expect(errors).toEqual(['內容已在別處被修改']);
    await expect.poll(() => store.getSnapshot()?.[0]?.name).toBe('別處改的');
    // A taken name is refused with its own reason.
    expect(await store.create('別處改的', false)).toBeNull();
    expect(errors[1]).toBe('這個項目已經有同名的分組');
    store.dispose();
  });

  it('reads again on project.groups_changed for its project only, and drops stale reads', async () => {
    const { project } = await seed();
    const other = await client.projects.create({ name: '別的', color: 1 });
    const store = new ProjectGroupsStore(client, { onError: () => undefined });
    await store.open(project.id);
    await client.projects.createGroup(project.id, { name: 'Agent 建的' });
    const event = (entityId: string, action: ChangeEvent['action']): ChangeEvent => ({
      seq: 1,
      entity: 'project',
      entity_id: entityId,
      action,
      data: {},
      actor: null,
      created_at: '2026-11-27T00:00:00.000Z',
    });
    store.onEvent(event(other.id, 'project.groups_changed'));
    store.onEvent(event(project.id, 'project.updated'));
    await new Promise((r) => setTimeout(r, 250));
    expect(store.getSnapshot()).toEqual([]);
    store.onEvent(event(project.id, 'project.groups_changed'));
    await expect.poll(() => store.getSnapshot()?.map((g) => g.name)).toEqual(['Agent 建的']);
    // Switching projects: the old project's answer never shows.
    const switching = store.open(other.id);
    expect(store.getSnapshot()).toBeNull();
    await switching;
    expect(store.getSnapshot()).toEqual([]);
    store.dispose();
  });
});
