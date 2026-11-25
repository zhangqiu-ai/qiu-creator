import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer, requiredAccess, type RegisteredRoute } from '@qiu-creator/mac-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  coverageOf,
  MCP_EXCLUDED,
  MCP_EXCLUDED_AREAS,
  MCP_PENDING,
  MCP_PENDING_AREAS,
  isReadOnly,
  toolRoutes,
  TOOLS,
} from '../mcp/index.js';

let routes: RegisteredRoute[] = [];
let home = '';

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-cov-'));
  const server = await buildServer({
    config: { home, token: 'mcp-coverage-token-0123456789' },
    ffprobe: null,
    ffmpeg: null,
    backups: { schedule: false },
  });
  await server.app.ready();
  // HEAD follows GET; the API is everything under /api/v1.
  routes = server.routes.filter((r) => r.url.startsWith('/api/v1') && r.method !== 'HEAD');
  await server.app.close();
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const key = (r: RegisteredRoute): string => `${r.method} ${r.url}`;

describe('MCP route coverage (docs/mcp-plan.md §6)', () => {
  it('classifies every /api/v1 route the server registers', () => {
    expect(routes.length).toBeGreaterThan(80);
    const missing = routes.filter((r) => coverageOf(r.method, r.url) === null).map(key);
    // A new route needs an MCP tool, an MCP_EXCLUDED reason, or an MCP_PENDING task.
    expect(missing).toEqual([]);
  });

  it('lists no route the server does not register', () => {
    const registered = new Set(routes.map(key));
    const stale = [
      ...toolRoutes().keys(),
      ...Object.keys(MCP_EXCLUDED),
      ...Object.keys(MCP_PENDING),
    ].filter((k) => !registered.has(k));
    expect(stale).toEqual([]);
    for (const area of [...MCP_EXCLUDED_AREAS, ...MCP_PENDING_AREAS]) {
      expect(
        routes.some((r) => r.url === area.prefix || r.url.startsWith(area.prefix)),
        area.prefix,
      ).toBe(true);
    }
  });

  it('gives each route one decision only', () => {
    const tool = new Set(toolRoutes().keys());
    const both = [...Object.keys(MCP_EXCLUDED), ...Object.keys(MCP_PENDING)].filter((k) =>
      tool.has(k),
    );
    expect(both).toEqual([]);
    expect(Object.keys(MCP_EXCLUDED).filter((k) => k in MCP_PENDING)).toEqual([]);
    for (const reason of [
      ...Object.values(MCP_EXCLUDED),
      ...Object.values(MCP_PENDING),
      ...MCP_EXCLUDED_AREAS.map((a) => a.reason),
    ]) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('MCP tool permissions match the server (scopes.ts)', () => {
  it("every tool's access equals requiredAccess for each route it calls", () => {
    const mismatches = TOOLS.flatMap((t) =>
      t.routes.flatMap((r) => {
        const [method = '', url = ''] = r.split(' ');
        const server = requiredAccess(method, url);
        return server === t.access
          ? []
          : [`${t.name}: ${r} is "${server}", tool says "${t.access}"`];
      }),
    );
    expect(mismatches).toEqual([]);
  });

  it('nothing is left pending since QC-088', () => {
    expect(MCP_PENDING).toEqual({});
    expect(MCP_PENDING_AREAS).toEqual([]);
    // Tools without routes run locally and work for every token.
    expect(TOOLS.filter((t) => t.routes.length === 0).map((t) => [t.name, t.access])).toEqual([
      ['platform_rules', 'any'],
    ]);
  });

  it('only read tools are marked read-only to the agent', () => {
    for (const t of TOOLS) {
      expect(isReadOnly(t.access), t.name).toBe(
        t.access !== 'import' &&
          t.access !== 'write' &&
          t.access !== 'propose' &&
          t.access !== 'report',
      );
    }
    expect(TOOLS.filter((t) => t.destructive === true).map((t) => t.name)).toEqual([
      'work_trash',
      'project_delete',
    ]);
  });
});
