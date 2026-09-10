// Fleet: SessionStart injection in server mode goes to /v1/context/recent;
// a 404 injects nothing, a transport error falls back only when allowed.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { contextHandler, setContextDependenciesForTesting } from '../../../src/cli/handlers/context.js';
import { ServerClientError } from '../../../src/services/hooks/server-client.js';
import { logger } from '../../../src/utils/logger.js';

const cwd = '/tmp/fleet-repo';
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let workerCalls: string[] = [];
let fallbackReasons: string[] = [];

function runtime(recentContext: (input: unknown) => Promise<unknown>, workerFallback = true) {
  return () => ({
    runtime: 'server' as const,
    projectId: '',
    serverBaseUrl: 'http://mem.test:37877',
    workerFallback,
    client: { recentContext } as never,
  });
}

// The seam is not cumulative (a call replaces the whole set), so every test
// passes its runtime through here.
function useRuntime(resolveRuntimeContext: () => unknown): void {
  setContextDependenciesForTesting({
    loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true' }) as never,
    shouldTrackProject: () => true,
    executeWithWorkerFallback: (async (path: string) => { workerCalls.push(path); return 'worker context'; }) as never,
    isWorkerFallback: () => false,
    logServerFallback: (reason: string) => { fallbackReasons.push(reason); },
    resolveRuntimeContext: resolveRuntimeContext as never,
  });
}

beforeEach(() => {
  workerCalls = [];
  fallbackReasons = [];
  loggerSpies = ['info', 'debug', 'warn', 'error'].map(m => spyOn(logger, m as 'info').mockImplementation(() => {}));
});

afterEach(() => {
  setContextDependenciesForTesting();
  loggerSpies.forEach(s => s.mockRestore());
});

describe('contextHandler server runtime', () => {
  it('injects the server context and never touches the worker', async () => {
    const calls: unknown[] = [];
    useRuntime(runtime(async (input) => {
        calls.push(input);
        const colors = (input as { colors?: boolean }).colors === true;
        return { context: colors ? '\x1b[36m# [fleet-repo] recent context\x1b[0m' : '# [fleet-repo] recent context\n\nbody', stats: null };
      }));
    const result = await contextHandler.execute({ cwd, platform: 'claude-code' } as never);
    expect(result.hookSpecificOutput?.additionalContext).toBe('# [fleet-repo] recent context\n\nbody');
    expect(result.systemMessage).toContain('\x1b[36m');
    expect(result.systemMessage).toContain('Memory server: http://mem.test:37877');
    expect(calls).toHaveLength(2);
    expect((calls[0] as { projects: string[] }).projects).toEqual(['fleet-repo']);
    expect((calls[0] as { platformSource: string }).platformSource).toBe('claude');
    expect(workerCalls).toEqual([]);
  });

  it('treats a 404 as empty context, not a fallback', async () => {
    useRuntime(runtime(async () => {
        throw new ServerClientError('http_error', 'nope', { status: 404 });
      }));
    const result = await contextHandler.execute({ cwd, platform: 'claude-code' } as never);
    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(result.systemMessage).toBeUndefined();
    expect(workerCalls).toEqual([]);
    expect(fallbackReasons).toEqual([]);
  });

  it('falls back to the worker on a transport error when allowed', async () => {
    useRuntime(runtime(async () => {
        throw new ServerClientError('transport', 'ECONNREFUSED');
      }));
    const result = await contextHandler.execute({ cwd, platform: 'claude-code' } as never);
    expect(fallbackReasons).toEqual(['transport']);
    expect(workerCalls.length).toBeGreaterThan(0);
    expect(result.hookSpecificOutput?.additionalContext).toBe('worker context');
  });

  it('injects nothing on a transport error when the fallback is off', async () => {
    useRuntime(runtime(async () => {
        throw new ServerClientError('transport', 'ECONNREFUSED');
      }, false));
    const result = await contextHandler.execute({ cwd, platform: 'claude-code' } as never);
    expect(fallbackReasons).toEqual([]);
    expect(workerCalls).toEqual([]);
    expect(result.hookSpecificOutput?.additionalContext).toBe('');
  });
});
