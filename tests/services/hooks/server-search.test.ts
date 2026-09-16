// Fleet: the MCP `search` tool never falls back to the local SQLite on the
// server runtime; it resolves the project like the hooks and maps every
// filter onto /v1/search.
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildServerSearchRequest } from '../../../src/services/hooks/server-search.js';
import { getProjectContext } from '../../../src/utils/project-name.js';

function runtime(projectId: string, resolveProjects: (names: string[]) => Promise<unknown> = async (names) => ({
  projects: names.map(name => ({ id: `id-${name}`, name })),
})) {
  return {
    runtime: 'server' as const,
    projectId,
    serverBaseUrl: 'http://mem.test',
    workerFallback: false,
    client: { resolveProjects } as never,
  };
}

const scratch = () => mkdtempSync(path.join(tmpdir(), 'cmem-search-'));

describe('buildServerSearchRequest', () => {
  it('uses the cwd repo when no project id is pinned and no project is named', async () => {
    const dir = scratch();
    const cwd = path.join(dir, 'my-repo');
    const req = await buildServerSearchRequest(runtime(''), { query: 'loopback bind' }, { cwd, cacheFile: path.join(dir, 'c.json') });
    expect(req).toEqual({ projectId: `id-${getProjectContext(cwd).primary}`, query: 'loopback bind' });
  });

  it('a pinned project id wins over the cwd', async () => {
    const req = await buildServerSearchRequest(runtime('fixed'), { query: 'q' }, { cwd: '/nowhere' });
    expect(req.projectId).toBe('fixed');
  });

  it('a named project is resolved on the server', async () => {
    const asked: string[][] = [];
    const rt = runtime('fixed', async (names) => { asked.push(names); return { projects: [{ id: 'p-other', name: 'other' }] }; });
    const req = await buildServerSearchRequest(rt, { query: 'q', project: 'other' });
    expect(req.projectId).toBe('p-other');
    expect(asked).toEqual([['other']]);
  });

  it('maps every filter the tool advertises onto the server request', async () => {
    const req = await buildServerSearchRequest(runtime('p'), {
      query: 'Headroom', limit: 5, offset: 10, platformSource: 'claude', obs_type: 'decision, bugfix',
      dateStart: '2026-09-10', dateEnd: '2026-09-14', orderBy: 'date_asc',
    });
    expect(req).toEqual({
      projectId: 'p', query: 'Headroom', limit: 5, offset: 10, platformSource: 'claude', kinds: ['decision', 'bugfix'],
      dateStartEpoch: Date.parse('2026-09-10T00:00:00.000Z'), dateEndEpoch: Date.parse('2026-09-14T23:59:59.999Z'), orderBy: 'date_asc',
    });
  });

  it('treats a non-category type as a kind filter, as the tool contract says', async () => {
    const req = await buildServerSearchRequest(runtime('p'), { query: 'q', type: 'decision' });
    expect(req.kinds).toEqual(['decision']);
    expect((await buildServerSearchRequest(runtime('p'), { query: 'q', type: 'observations' })).kinds).toBeUndefined();
  });

  it('refuses what the server does not hold instead of falling back', async () => {
    await expect(buildServerSearchRequest(runtime('p'), { query: 'q', type: 'sessions' })).rejects.toThrow(/not on the server/);
    await expect(buildServerSearchRequest(runtime('p'), { query: 'q', orderBy: 'relevance' })).rejects.toThrow(/orderBy/);
    await expect(buildServerSearchRequest(runtime('p'), { query: 'q', dateStart: 'yesterday' })).rejects.toThrow(/ISO date/);
    await expect(buildServerSearchRequest(runtime('p'), { query: '  ' })).rejects.toThrow(/query is required/);
  });
});
