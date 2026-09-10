// SPDX-License-Identifier: Apache-2.0
//
// Zabaca fleet fork — the claude-sdk server provider. `makeContext` is a copy
// of the one in providers.test.ts, deliberately: this file is additive and
// must not touch upstream's.

import { describe, expect, it } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { RunHooks, RunOutcome } from '@zabaca/agent';
import {
  ClaudeSdkObservationProvider,
  DEFAULT_SERVER_CLAUDE_SDK_MODEL,
  classifyClaudeSdkError,
  type ClaudeSdkRunImpl,
} from '../../../src/server/generation/providers/ClaudeSdkObservationProvider.js';
import { ServerClassifiedProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

function makeContext(overrides: Partial<{ payload: unknown; serverSessionId: string | null }> = {}): ServerGenerationContext {
  return {
    job: {
      id: 'job-1',
      projectId: 'proj-1',
      teamId: 'team-1',
      agentEventId: 'evt-1',
      sourceType: 'agent_event',
      sourceId: 'evt-1',
      serverSessionId: overrides.serverSessionId ?? null,
      jobType: 'observation_generate_for_event',
      status: 'processing',
      idempotencyKey: 'k',
      bullmqJobId: null,
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAtEpoch: null,
      lockedAtEpoch: null,
      lockedBy: null,
      completedAtEpoch: null,
      failedAtEpoch: null,
      cancelledAtEpoch: null,
      lastError: null,
      payload: {},
      createdAtEpoch: 0,
      updatedAtEpoch: 0,
    },
    events: [
      {
        id: 'evt-1',
        projectId: 'proj-1',
        teamId: 'team-1',
        serverSessionId: overrides.serverSessionId ?? null,
        sourceAdapter: 'api',
        sourceEventId: null,
        idempotencyKey: 'k',
        eventType: 'tool_use',
        payload: overrides.payload ?? { tool: 'bash', input: 'ls' },
        metadata: {},
        occurredAtEpoch: 0,
        receivedAtEpoch: 0,
        createdAtEpoch: 0,
      },
    ],
    project: {
      projectId: 'proj-1',
      teamId: 'team-1',
      serverSessionId: overrides.serverSessionId ?? null,
      projectName: 'demo',
    },
  };
}

function outcome(extra: Partial<RunOutcome> = {}): RunOutcome {
  return {
    text: '<observation>hi</observation>',
    turns: 1,
    stopReason: 'success',
    isError: false,
    errors: [],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 400,
    } as RunOutcome['usage'],
    modelUsage: {},
    totalCostUsd: 0.001,
    sessionId: 'sess-1',
    ...extra,
  };
}

const CLAUDE_PATH = '/usr/local/bin/claude';

function providerWith(runImpl: ClaudeSdkRunImpl, extra: Partial<ConstructorParameters<typeof ClaudeSdkObservationProvider>[0]> = {}) {
  return new ClaudeSdkObservationProvider({ claudePath: CLAUDE_PATH, runImpl, ...extra });
}

async function classified(promise: Promise<unknown>): Promise<ServerClassifiedProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ServerClassifiedProviderError);
    return error as ServerClassifiedProviderError;
  }
  throw new Error('expected the provider to throw');
}

describe('ClaudeSdkObservationProvider', () => {
  it('does not spawn anything when every event was private', async () => {
    let calls = 0;
    const provider = providerWith(async () => { calls++; return outcome(); });
    const result = await provider.generate(makeContext({ payload: '<private>secret</private>' }));
    expect(calls).toBe(0);
    expect(result.rawText).toBe('<skip_summary reason="all_events_private" />');
    expect(result.providerLabel).toBe('claude-sdk');
  });

  it('returns the text, all four usage buckets, the label and the default model', async () => {
    const provider = providerWith(async () => outcome());
    const result = await provider.generate(makeContext());
    expect(result.rawText).toBe('<observation>hi</observation>');
    // input_tokens excludes the cached prefix, so the cache buckets count too.
    expect(result.tokensUsed).toBe(100 + 20 + 30 + 400);
    expect(result.providerLabel).toBe('claude-sdk');
    expect(result.modelId).toBe(DEFAULT_SERVER_CLAUDE_SDK_MODEL);
  });

  it('hands the SDK minimal options with the CLI path, a controller and an allowlisted env', async () => {
    let seen: Options | undefined;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test';
    process.env.CLAUDE_MEM_SERVER_DATABASE_URL = 'postgres://should-not-leak';
    try {
      const provider = providerWith(async (_prompt, options) => { seen = options; return outcome(); }, { model: 'claude-sonnet-5' });
      await provider.generate(makeContext());
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_MEM_SERVER_DATABASE_URL;
    }
    expect(seen).toBeDefined();
    expect(seen!.abortController).toBeInstanceOf(AbortController);
    expect(seen!.tools).toEqual([]);
    expect(seen!.pathToClaudeCodeExecutable).toBe(CLAUDE_PATH);
    expect(seen!.permissionMode).toBe('dontAsk');
    expect(seen!.model).toBe('claude-sonnet-5');
    expect(seen!.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
    expect('CLAUDE_MEM_SERVER_DATABASE_URL' in (seen!.env ?? {})).toBe(false);
  });

  it('times out as transient, through the controller it handed the SDK', async () => {
    const provider = providerWith(
      (_prompt, options) => new Promise((_resolve, reject) => {
        options.abortController!.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
      { timeoutMs: 10 },
    );
    const err = await classified(provider.generate(makeContext()));
    expect(err.kind).toBe('transient');
    expect(err.message).toContain('timeout after 10ms');
  });

  it('reports an error outcome as a classified error rather than returning it', async () => {
    const provider = providerWith(async () => outcome({
      isError: true,
      stopReason: 'error_during_execution',
      errors: ['Failed to authenticate: OAuth session expired'],
    }));
    const err = await classified(provider.generate(makeContext()));
    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies a thrown SDK error too — newer SDKs throw on an error result', async () => {
    const provider = providerWith(async () => {
      throw new Error('Claude Code returned an error result: Failed to authenticate. API Error: 401');
    });
    const err = await classified(provider.generate(makeContext()));
    expect(err.kind).toBe('auth_invalid');
  });

  it('turns a rejected rate_limit_event into rate_limit with retryAfterMs from resetsAt', async () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 600;
    const provider = providerWith(async (_prompt, _options, hooks: RunHooks) => {
      hooks.onMessage?.({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: resetsAtSeconds, rateLimitType: 'five_hour' },
        uuid: '00000000-0000-0000-0000-000000000000',
        session_id: 's',
      } as never);
      return outcome({ isError: true, stopReason: 'error_during_execution', errors: ['limit'] });
    });
    const err = await classified(provider.generate(makeContext()));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBeGreaterThan(9 * 60 * 1000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('returns empty text without throwing — the pipeline treats it as a skip', async () => {
    const provider = providerWith(async () => outcome({ text: '' }));
    const result = await provider.generate(makeContext());
    expect(result.rawText).toBe('');
    expect(result.providerLabel).toBe('claude-sdk');
  });
});

describe('classifyClaudeSdkError', () => {
  const cases: Array<[string, Parameters<typeof classifyClaudeSdkError>[0], string]> = [
    ['our timer fired', { cause: new Error('x'), timedOut: true, timeoutMs: 5 }, 'transient'],
    ['AbortError not ours', { cause: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 'transient'],
    ['CLI missing', { cause: new Error('spawn /nope ENOENT') }, 'unrecoverable'],
    ['native binary', { cause: new Error('Native CLI binary not found') }, 'unrecoverable'],
    ['rejected rate limit', { cause: new Error('x'), rejectedRateLimit: { status: 'rejected' } }, 'rate_limit'],
    ['max turns', { cause: new Error('x'), stopReason: 'error_max_turns' }, 'unrecoverable'],
    ['max budget', { cause: new Error('x'), stopReason: 'error_max_budget_usd' }, 'quota_exhausted'],
    ['not logged in', { cause: new Error('Not logged in · run /login') }, 'auth_invalid'],
    ['401 in errors', { cause: new Error('run failed'), errors: ['API Error: 401 unauthorized'] }, 'auth_invalid'],
    ['429', { cause: new Error('API Error: 429 too many requests') }, 'rate_limit'],
    ['usage limit', { cause: new Error("You've hit your limit") }, 'quota_exhausted'],
    ['overloaded → upstream classifier', { cause: new Error('overloaded_error') }, 'transient'],
    ['prompt too long → upstream classifier', { cause: new Error('prompt is too long') }, 'unrecoverable'],
    ['unknown → upstream network fallback', { cause: new Error('something odd') }, 'transient'],
  ];
  for (const [name, input, kind] of cases) {
    it(`${name} → ${kind}`, () => {
      expect(classifyClaudeSdkError(input).kind).toBe(kind);
    });
  }

  it('caps retryAfterMs at six hours', () => {
    const err = classifyClaudeSdkError({
      cause: new Error('x'),
      rejectedRateLimit: { status: 'rejected', resetsAt: Date.now() + 7 * 24 * 60 * 60 * 1000 },
    });
    expect(err.retryAfterMs).toBe(6 * 60 * 60 * 1000);
  });
});
