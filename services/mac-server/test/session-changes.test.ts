import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@qiu-creator/api-client';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(): Promise<TestServer> {
  const s = await startTestServer();
  servers.push(s);
  return s;
}

describe('GET /api/v1/session (QC-087)', () => {
  it('tells every token who it is and what it may do', async () => {
    const s = await start();
    expect(await s.client.session()).toEqual({
      kind: 'owner',
      name: null,
      scopes: ['read', 'import', 'write', 'propose'],
      allow_direct_body_edit: false,
      project_ids: null,
    });
    for (const scopes of [['read'], ['import'], ['write']] as const) {
      const t = s.tokens.create({ name: `agent-${scopes[0]}`, scopes: [...scopes] });
      const agent = createClient({ baseUrl: s.baseUrl, token: t.secret });
      expect(await agent.session()).toEqual({
        kind: 'agent',
        name: `agent-${scopes[0]}`,
        scopes: [...scopes],
        allow_direct_body_edit: false,
        project_ids: null,
      });
    }
    const res = await fetch(`${s.baseUrl}/api/v1/session`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/changes (QC-087)', () => {
  it('pages the change log after a seq', async () => {
    const s = await start();
    const a = await s.client.works.create({ title: 'A' });
    const b = await s.client.works.create({ title: 'B' });
    const all = await s.client.changes();
    expect(all.items.map((e) => [e.action, e.entity_id])).toEqual([
      ['work.created', a.id],
      ['work.created', b.id],
    ]);
    expect(all).toMatchObject({ has_more: false, latest_seq: all.next_since });

    const first = await s.client.changes({ since: 0, limit: 1 });
    expect(first.items.map((e) => e.entity_id)).toEqual([a.id]);
    expect(first.has_more).toBe(true);
    const second = await s.client.changes({ since: first.next_since, limit: 1 });
    expect(second.items.map((e) => e.entity_id)).toEqual([b.id]);
    expect(second.has_more).toBe(false);
    // Nothing new: next_since stays where it was.
    const none = await s.client.changes({ since: second.next_since });
    expect(none).toMatchObject({ items: [], next_since: second.next_since, has_more: false });

    const bad = await fetch(`${s.baseUrl}/api/v1/changes?limit=501`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('needs the read scope', async () => {
    const s = await start();
    const importer = s.tokens.create({ name: 'imp', scopes: ['import'] });
    const res = await fetch(`${s.baseUrl}/api/v1/changes`, {
      headers: { authorization: `Bearer ${importer.secret}` },
    });
    expect(res.status).toBe(403);
  });
});
