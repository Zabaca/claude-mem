// SPDX-License-Identifier: Apache-2.0
//
// Zabaca fleet fork — CLAUDE_MEM_SERVER_PROVIDER=claude-sdk reaches the
// provider through the runtime's env wiring.

import { afterEach, describe, expect, it } from 'bun:test';
import { ClaudeSdkObservationProvider } from '../../src/server/generation/providers/ClaudeSdkObservationProvider.js';
import {
  instantiateServerGenerationProvider,
  warnIfClaudeSdkHasNoCredential,
} from '../../src/server/runtime/create-server-service.js';

const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

describe('claude-sdk provider from env', () => {
  it('constructs the provider with the configured CLI path and model', async () => {
    setEnv({
      CLAUDE_MEM_SERVER_CLAUDE_PATH: '/bin/true',
      CLAUDE_MEM_SERVER_MODEL: 'claude-sonnet-5',
      CLAUDE_MEM_SERVER_SDK_TIMEOUT_MS: '5000',
    });
    const provider = instantiateServerGenerationProvider('claude-sdk');
    expect(provider).toBeInstanceOf(ClaudeSdkObservationProvider);
    expect(provider!.providerLabel).toBe('claude-sdk');

    // The skip path never spawns the CLI, and carries the model through.
    const result = await provider!.generate({
      job: {
        id: 'job-1', projectId: 'p', teamId: 't', agentEventId: 'e', sourceType: 'agent_event', sourceId: 'e',
        serverSessionId: null, jobType: 'observation_generate_for_event', status: 'processing', idempotencyKey: 'k',
        bullmqJobId: null, attempts: 1, maxAttempts: 3, nextAttemptAtEpoch: null, lockedAtEpoch: null, lockedBy: null,
        completedAtEpoch: null, failedAtEpoch: null, cancelledAtEpoch: null, lastError: null, payload: {},
        createdAtEpoch: 0, updatedAtEpoch: 0,
      },
      events: [{
        id: 'e', projectId: 'p', teamId: 't', serverSessionId: null, sourceAdapter: 'api', sourceEventId: null,
        idempotencyKey: 'k', eventType: 'tool_use', payload: '<private>secret</private>', metadata: {},
        occurredAtEpoch: 0, receivedAtEpoch: 0, createdAtEpoch: 0,
      }],
      project: { projectId: 'p', teamId: 't', serverSessionId: null, projectName: 'demo' },
    });
    expect(result.modelId).toBe('claude-sonnet-5');
    expect(result.providerLabel).toBe('claude-sdk');
  });

  it('leaves the other labels alone', () => {
    setEnv({ ANTHROPIC_API_KEY: undefined, CLAUDE_MEM_ANTHROPIC_API_KEY: undefined });
    expect(instantiateServerGenerationProvider('claude')).toBeNull();
    expect(instantiateServerGenerationProvider('nope')).toBeNull();
  });
});

describe('warnIfClaudeSdkHasNoCredential', () => {
  it('is satisfied by any other provider, or by an OAuth token', () => {
    expect(warnIfClaudeSdkHasNoCredential({ CLAUDE_MEM_SERVER_PROVIDER: 'claude' })).toBe(true);
    expect(warnIfClaudeSdkHasNoCredential({
      CLAUDE_MEM_SERVER_PROVIDER: 'claude-sdk',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    })).toBe(true);
  });

  it('warns, and does not throw, when nothing is visible', () => {
    expect(warnIfClaudeSdkHasNoCredential({
      CLAUDE_MEM_SERVER_PROVIDER: 'claude-sdk',
      HOME: '/nonexistent-home-for-test',
      CLAUDE_MEM_CREDENTIALS_FILE: '/nonexistent/creds.json',
    })).toBe(false);
  });
});
