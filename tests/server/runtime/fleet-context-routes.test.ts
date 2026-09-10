// SPDX-License-Identifier: Apache-2.0
//
// Fleet: POST /v1/projects/resolve, POST /v1/context/recent and
// GET /v1/observations/latest, plus the api-key CLI's --team-scoped and
// revoke --name. Needs CLAUDE_MEM_TEST_POSTGRES_URL (a throwaway
// `docker run postgres:17-alpine` is enough).

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { logger } from '../../../src/utils/logger.js';
import { createIsolatedSchema, dropSchema, newApiKey, poolForSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('fleet context routes', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let teamKey: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_fleet');
    pool = poolForSchema(testDatabaseUrl, schemaName);
    const client = await pool.connect();
    try {
      await bootstrapServerPostgresSchema(client);
    } finally {
      client.release();
    }
    storage = createPostgresStorageRepositories(pool as never);
    const team = await storage.teams.create({ name: 'fleet' });
    teamId = team.id;
    const { raw, hash } = newApiKey();
    teamKey = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId: null,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
    });

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await pool.end();
    await dropSchema(testDatabaseUrl, schemaName);
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function call(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    });
  }

  async function resolve(names: string[], key = teamKey): Promise<Array<{ id: string; name: string }>> {
    const res = await call('/v1/projects/resolve', key, { method: 'POST', body: JSON.stringify({ names }) });
    expect(res.status).toBe(200);
    return (await res.json()).projects;
  }

  it('resolve creates once and returns the same ids in request order', async () => {
    const first = await resolve(['repo', 'repo/wt']);
    expect(first.map(p => p.name)).toEqual(['repo', 'repo/wt']);
    const again = await resolve(['repo/wt', 'repo']);
    expect(again.map(p => p.name)).toEqual(['repo/wt', 'repo']);
    expect(again[1]!.id).toBe(first[0]!.id);
    expect(again[0]!.id).toBe(first[1]!.id);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM projects WHERE team_id = $1', [teamId]);
    expect(count.rows[0].n).toBe(2);
  });

  it('resolve refuses a project-scoped key asking for another project', async () => {
    const [own] = await resolve(['mine']);
    const { raw, hash } = newApiKey();
    await storage.auth.createApiKey({
      keyHash: hash, teamId, projectId: own!.id, actorId: 'test', scopes: ['memories:read', 'memories:write'],
    });
    expect((await resolve(['mine'], raw))[0]!.id).toBe(own!.id);
    const res = await call('/v1/projects/resolve', raw, { method: 'POST', body: JSON.stringify({ names: ['other'] }) });
    expect(res.status).toBe(403);
  });

  it('recent renders the welcome state for an unknown bucket and creates nothing', async () => {
    const res = await call('/v1/context/recent', teamKey, {
      method: 'POST', body: JSON.stringify({ projects: ['never-seen'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).toContain('# [never-seen] recent context');
    expect(body.context).toContain('No previous sessions found.');
    expect(body.stats).toBeNull();
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM projects');
    expect(count.rows[0].n).toBe(0);
  });

  it('recent renders observations and the summary across parent and worktree', async () => {
    const [parent, wt] = await resolve(['repo', 'repo/wt']);
    await storage.observations.create({
      projectId: parent!.id, teamId, kind: 'discovery', content: 'found the thing',
      metadata: { title: 'Found the thing', subtitle: 'in parent', facts: ['a fact'], concepts: ['how-it-works'], narrative: 'found it' },
    });
    await storage.observations.create({
      projectId: wt!.id, teamId, kind: 'decision', content: 'decided',
      metadata: { title: 'Chose the fork', facts: [], concepts: ['what-changed'], narrative: 'chose it' },
    });
    await storage.observations.create({
      projectId: wt!.id, teamId, kind: 'summary', content: 'summary',
      metadata: { request: 'do the thing', investigated: 'x', learned: 'y', completed: 'z', next_steps: 'more' },
    });
    // Filtered out: a kind the mode does not list.
    await storage.observations.create({
      projectId: wt!.id, teamId, kind: 'manual', content: 'manual note', metadata: { concepts: ['what-changed'] },
    });
    const res = await call('/v1/context/recent', teamKey, {
      method: 'POST', body: JSON.stringify({ projects: ['repo', 'repo/wt'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).toContain('# [repo/wt] recent context');
    expect(body.context).toContain('Found the thing');
    expect(body.context).toContain('Chose the fork');
    expect(body.context).not.toContain('manual note');
    expect(body.stats.observation_count).toBe(2);
    expect(body.stats.has_session_summary).toBe(true);

    const colored = await call('/v1/context/recent', teamKey, {
      method: 'POST', body: JSON.stringify({ projects: ['repo', 'repo/wt'], colors: true }),
    });
    expect((await colored.json()).context).toContain('\x1b[');
  });

  it('latest reports the newest observation for the team', async () => {
    let res = await call('/v1/observations/latest', teamKey);
    expect(await res.json()).toEqual({ createdAt: null, count: 0 });
    const [p] = await resolve(['repo']);
    await storage.observations.create({ projectId: p!.id, teamId, kind: 'discovery', content: 'x', metadata: {} });
    res = await call('/v1/observations/latest', teamKey);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(typeof body.createdAt).toBe('string');
  });

  it('api-key create --team-scoped --team mints a key with no project; revoke --name finds it', async () => {
    const { runServerApiKeyCli } = await import('../../../src/server/runtime/ServerService.js');
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
    const prevUrl = process.env.CLAUDE_MEM_SERVER_DATABASE_URL;
    const prevRuntime = process.env.CLAUDE_MEM_RUNTIME;
    process.env.CLAUDE_MEM_RUNTIME = 'server';
    process.env.CLAUDE_MEM_SERVER_DATABASE_URL = `${testDatabaseUrl}${testDatabaseUrl.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schemaName}`;
    try {
      await runServerApiKeyCli(['create', '--name', 'mac-studio', '--team', teamId, '--team-scoped', '--scope', 'memories:read,memories:write']);
      const created = JSON.parse(lines.pop()!);
      expect(created.teamId).toBe(teamId);
      expect(created.projectId).toBeNull();
      expect(created.name).toBe('mac-studio');
      expect(created.key).toMatch(/^cmem_/);

      // The key can resolve and write any project in its team.
      const projects = await resolve(['anything'], created.key);
      expect(projects).toHaveLength(1);

      await runServerApiKeyCli(['list', '--team', teamId]);
      const listed = JSON.parse(lines.pop()!);
      expect(listed.keys.find((k: { id: string }) => k.id === created.id).name).toBe('mac-studio');

      await runServerApiKeyCli(['revoke', '--name', 'mac-studio']);
      const revoked = JSON.parse(lines.pop()!);
      expect(revoked.revoked).toEqual([created.id]);
      const res = await call('/v1/projects/resolve', created.key, { method: 'POST', body: JSON.stringify({ names: ['x'] }) });
      expect(res.status).toBe(403);
    } finally {
      logSpy.mockRestore();
      if (prevUrl === undefined) delete process.env.CLAUDE_MEM_SERVER_DATABASE_URL; else process.env.CLAUDE_MEM_SERVER_DATABASE_URL = prevUrl;
      if (prevRuntime === undefined) delete process.env.CLAUDE_MEM_RUNTIME; else process.env.CLAUDE_MEM_RUNTIME = prevRuntime;
    }
  });
});
