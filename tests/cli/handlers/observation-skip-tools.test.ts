import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realServerProject from '../../../src/services/hooks/server-project.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realServerProjectSnapshot = { ...realServerProject };
const originalInternalEnv = process.env.CLAUDE_MEM_INTERNAL;

const settings = {
  CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_RUNTIME: 'server',
  CLAUDE_MEM_SKIP_TOOLS: 'TodoWrite, Bash',
};

const recorded: Array<{ payload: { tool_name: string } }> = [];
let workerCalled = false;

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => (key === 'CLAUDE_MEM_DATA_DIR' ? join(homedir(), '.claude-mem') : ''),
    getInt: () => 0,
    loadFromFile: () => settings,
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => settings,
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async () => {
    workerCalled = true;
    return { status: 'queued' };
  },
  isWorkerFallback: () => false,
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server',
    projectId: 'server-project-1',
    serverBaseUrl: 'http://server.test',
    client: {
      recordEvent: async (event: { payload: { tool_name: string } }) => {
        recorded.push(event);
        return {};
      },
    },
  }),
  logServerFallback: () => {},
}));

mock.module('../../../src/services/hooks/server-project.js', () => ({
  resolveServerProjectId: async () => 'server-project-1',
}));

import { observationHandler } from '../../../src/cli/handlers/observation.js';

const input = (toolName: string) => ({
  sessionId: 'session-1',
  cwd: '/tmp/some-repo',
  platform: 'claude-code',
  toolName,
  toolInput: { command: 'ls' },
  toolResponse: 'ok',
});

describe('observation hook honours CLAUDE_MEM_SKIP_TOOLS on the server lane', () => {
  beforeEach(() => {
    recorded.length = 0;
    workerCalled = false;
    delete process.env.CLAUDE_MEM_INTERNAL;
  });

  afterAll(() => {
    mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
    mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
    mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
    mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
    mock.module('../../../src/services/hooks/server-project.js', () => realServerProjectSnapshot);
    if (originalInternalEnv === undefined) delete process.env.CLAUDE_MEM_INTERNAL;
    else process.env.CLAUDE_MEM_INTERNAL = originalInternalEnv;
  });

  it('sends nothing for a listed tool, despite the space after the comma', async () => {
    const result = await observationHandler.execute(input('Bash') as never);
    expect(result.continue).toBe(true);
    expect(recorded).toHaveLength(0);
    expect(workerCalled).toBe(false);
  });

  it('records an unlisted tool as an event', async () => {
    await observationHandler.execute(input('Edit') as never);
    expect(recorded.map(e => e.payload.tool_name)).toEqual(['Edit']);
  });

  it('matches whole names only', async () => {
    await observationHandler.execute(input('BashOutput') as never);
    expect(recorded.map(e => e.payload.tool_name)).toEqual(['BashOutput']);
  });
});
