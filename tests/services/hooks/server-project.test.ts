// Fleet: per-repo project ids are resolved once per server and cached in a
// 0600 file, since every hook is its own process.
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveServerProjectId } from '../../../src/services/hooks/server-project.js';
import { getProjectContext } from '../../../src/utils/project-name.js';

function runtime(projectId: string, resolveProjects: (names: string[]) => Promise<unknown>) {
  return {
    runtime: 'server' as const,
    projectId,
    serverBaseUrl: 'http://mem.test',
    workerFallback: false,
    client: { resolveProjects } as never,
  };
}

describe('resolveServerProjectId', () => {
  it('returns the fixed id without asking the server', async () => {
    let asked = false;
    const id = await resolveServerProjectId(runtime('fixed', async () => { asked = true; return { projects: [] }; }), '/tmp/x');
    expect(id).toBe('fixed');
    expect(asked).toBe(false);
  });

  it('resolves the cwd project once and caches it at 0600', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmem-projects-'));
    const cacheFile = path.join(dir, 'server-projects.json');
    const cwd = path.join(dir, 'my-repo');
    const expectedName = getProjectContext(cwd).primary;
    const asked: string[][] = [];
    const rt = runtime('', async (names) => {
      asked.push(names);
      return { projects: names.map(name => ({ id: `id-${name}`, name })) };
    });
    expect(await resolveServerProjectId(rt, cwd, { cacheFile })).toBe(`id-${expectedName}`);
    expect(await resolveServerProjectId(rt, cwd, { cacheFile })).toBe(`id-${expectedName}`);
    expect(asked).toEqual([[expectedName]]);
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({ 'http://mem.test': { [expectedName]: `id-${expectedName}` } });
  });
});
