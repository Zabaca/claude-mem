// SPDX-License-Identifier: Apache-2.0

// Server provider that generates through the Claude Agent SDK — i.e. through
// the Claude Code CLI — instead of a raw `fetch` with `x-api-key`. The point is
// the credential: the CLI authenticates with a subscription OAuth token
// (`CLAUDE_CODE_OAUTH_TOKEN`, or the credentials file the Docker entrypoint
// materialises), which the Messages REST API used by ClaudeObservationProvider
// cannot take. Additive: that provider is untouched and stays the default
// `claude`; this one is selected with CLAUDE_MEM_SERVER_PROVIDER=claude-sdk.
//
// `@zabaca/agent`'s minimalOptions() is what keeps this cheap. SDK defaults
// ship every tool schema and settings source (~23K input tokens per call);
// stripped, the same query is ~124 tokens of overhead, thinking is off, and
// auto-memory is off — which in a memory system is a correctness fix, not a
// token one: the operator's own memory index must not leak into the prompt
// that summarises someone else's session.

import { minimalOptions, run, type RunHooks, type RunOutcome } from '@zabaca/agent';
import type { Options, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../utils/logger.js';
import { classifyClaudeServerError } from './ClaudeObservationProvider.js';
import { ServerClassifiedProviderError } from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

// Haiku, deliberately, where the REST provider defaults to sonnet-5. This is an
// extraction task — XML summaries of tool events — and the upstream *local*
// worker's default is haiku for the same job; sonnet is ~10x the cost for no
// measurable gain on it.
export const DEFAULT_SERVER_CLAUDE_SDK_MODEL = 'claude-haiku-4-5-20251001';

// Must stay well under the 5-minute BullMQ lock in src/server/jobs/
// ServerJobQueue.ts: nothing upstream passes an AbortSignal into generate()
// (ProviderObservationGenerator.process), so this timer is the only thing that
// stops a hung CLI subprocess before the lock expires and the job is re-run
// alongside it.
export const DEFAULT_SERVER_SDK_TIMEOUT_MS = 120_000;

// Rate-limit resets on a subscription can be a day out. Anything past this is
// treated as "retry in six hours" rather than parking the job for a week.
const MAX_RATE_LIMIT_RETRY_MS = 6 * 60 * 60 * 1000;

export type ClaudeSdkRunImpl = (
  prompt: string,
  options: Options,
  hooks: RunHooks,
) => Promise<RunOutcome>;

export interface ClaudeSdkObservationProviderOptions {
  model?: string;
  timeoutMs?: number;
  /**
   * Path to the Claude Code CLI. Mandatory in practice: SDK 0.3.220 resolves a
   * native CLI binary relative to `import.meta.url`, which cannot work inside
   * the esbuild CJS bundle — the worker lane always passes it too
   * (src/services/worker/ClaudeProvider.ts). The runtime resolves it with
   * findClaudeExecutable() when CLAUDE_MEM_SERVER_CLAUDE_PATH is unset.
   */
  claudePath: string;
  /** Extra environment for the CLI subprocess, over the essential allowlist. */
  env?: Record<string, string | undefined>;
  /** Test seam, like the REST providers' `fetchImpl`. */
  runImpl?: ClaudeSdkRunImpl;
}

export class ClaudeSdkObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude-sdk' as const;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly claudePath: string;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly runImpl: ClaudeSdkRunImpl;

  constructor(options: ClaudeSdkObservationProviderOptions) {
    this.model = options.model ?? DEFAULT_SERVER_CLAUDE_SDK_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_SDK_TIMEOUT_MS;
    this.claudePath = options.claudePath;
    this.env = options.env;
    this.runImpl = options.runImpl ?? run;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      // All events were scrubbed by privacy stripping. Don't spawn the CLI —
      // return the synthetic skip response the parser accepts.
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    // The SDK takes an AbortController, not a signal, so the inbound signal
    // (if a future caller passes one) is chained onto a controller we own.
    const abortController = new AbortController();
    let timedOut = false;
    const onInboundAbort = () => abortController.abort();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', onInboundAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.timeoutMs);

    const options: Options = {
      // inheritEnv: false → the ESSENTIAL_ENV allowlist: PATH/HOME (the
      // credentials file lives under HOME), the ANTHROPIC_* and
      // CLAUDE_CODE_OAUTH_TOKEN credentials, proxy and CA variables. Every
      // CLAUDE_MEM_* variable and the CLAUDECODE nesting markers are dropped,
      // so the worker's own config never reaches the subprocess.
      ...minimalOptions({
        model: this.model,
        abortController,
        inheritEnv: false,
        ...(this.env === undefined ? {} : { env: this.env }),
      }),
      pathToClaudeCodeExecutable: this.claudePath,
      // Headless; with `tools: []` there is nothing to ask about anyway.
      permissionMode: 'dontAsk',
    };

    let rejectedRateLimit: SDKRateLimitInfo | undefined;
    const hooks: RunHooks = {
      onMessage: (message: SDKMessage) => {
        if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
          rejectedRateLimit = message.rate_limit_info;
        }
      },
    };

    let outcome: RunOutcome;
    try {
      outcome = await this.runImpl(prompt, options, hooks);
    } catch (error) {
      throw classifyClaudeSdkError({
        cause: error,
        timedOut,
        timeoutMs: this.timeoutMs,
        rejectedRateLimit,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onInboundAbort);
    }

    if (outcome.isError) {
      throw classifyClaudeSdkError({
        cause: new Error(
          `Claude SDK run failed (${outcome.stopReason}): ${outcome.errors.join('; ') || 'no error text'}`,
        ),
        stopReason: outcome.stopReason,
        errors: outcome.errors,
        timedOut,
        timeoutMs: this.timeoutMs,
        rejectedRateLimit,
      });
    }

    const rawText = outcome.text;
    if (!rawText) {
      // Parity with ClaudeObservationProvider: empty text is a skip further
      // up (processGeneratedResponse), whereas a parse_error would dead-letter.
      logger.warn('SDK', 'Claude SDK returned no text', {
        provider: this.providerLabel,
        model: this.model,
        stopReason: outcome.stopReason,
      });
    }

    // All four buckets: `input_tokens` excludes the cached prefix, and with
    // prompt caching most of a repeated system prompt lands in cache_read.
    const usage = outcome.usage;
    const tokensUsed = usage
      ? (usage.input_tokens ?? 0)
        + (usage.output_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
      : undefined;

    logger.debug('SDK', 'Claude SDK generation complete', {
      provider: this.providerLabel,
      model: this.model,
      totalCostUsd: outcome.totalCostUsd,
      sessionId: outcome.sessionId,
      turns: outcome.turns,
      tokensUsed,
    });

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

export interface ClassifyClaudeSdkInput {
  cause: unknown;
  timedOut?: boolean;
  timeoutMs?: number;
  stopReason?: string;
  errors?: readonly string[];
  rejectedRateLimit?: SDKRateLimitInfo;
}

const LAUNCH_FAILURE = /executable not found|failed to launch|ENOENT|Native CLI binary/i;
const AUTH_FAILURE = /oauth|not logged in|\/login|authentication_error|token.*expired|\b401\b|\b403\b/i;
const RATE_LIMIT = /\b429\b|rate.?limit/i;
const QUOTA = /usage limit|hit your limit|out of credits|quota/i;

/**
 * Map what the SDK gave us onto the server error model. Only `transient` and
 * `rate_limit` retry; everything else dead-letters the job, so the order here
 * is "most specific signal first".
 */
export function classifyClaudeSdkError(input: ClassifyClaudeSdkInput): ServerClassifiedProviderError {
  const cause = input.cause;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const text = [causeMessage, ...(input.errors ?? [])].join('\n');

  if (input.timedOut) {
    return new ServerClassifiedProviderError(
      `claude-sdk timeout after ${input.timeoutMs ?? DEFAULT_SERVER_SDK_TIMEOUT_MS}ms`,
      { kind: 'transient', cause },
    );
  }

  if (cause instanceof Error && cause.name === 'AbortError') {
    return new ServerClassifiedProviderError('claude-sdk run aborted', {
      kind: 'transient',
      cause,
    });
  }

  if (LAUNCH_FAILURE.test(text)) {
    logger.error('SDK', 'claude-sdk: the Claude Code CLI could not be launched; set CLAUDE_MEM_SERVER_CLAUDE_PATH', {
      provider: 'claude-sdk',
    }, cause instanceof Error ? cause : undefined);
    return new ServerClassifiedProviderError(`claude-sdk CLI launch failed: ${causeMessage}`, {
      kind: 'unrecoverable',
      cause,
    });
  }

  if (input.rejectedRateLimit) {
    const retryAfterMs = retryAfterFromResetsAt(input.rejectedRateLimit.resetsAt);
    return new ServerClassifiedProviderError(
      `claude-sdk rate limited (${input.rejectedRateLimit.rateLimitType ?? 'unknown window'})`,
      {
        kind: 'rate_limit',
        cause,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }

  if (input.stopReason === 'error_max_turns') {
    // Impossible with `tools: []` — a single turn cannot exceed maxTurns — so
    // if it happens the configuration is wrong, not the network.
    return new ServerClassifiedProviderError('claude-sdk hit max turns', {
      kind: 'unrecoverable',
      cause,
    });
  }

  if (input.stopReason === 'error_max_budget_usd') {
    return new ServerClassifiedProviderError('claude-sdk hit max budget', {
      kind: 'quota_exhausted',
      cause,
    });
  }

  if (AUTH_FAILURE.test(text)) {
    return new ServerClassifiedProviderError(`claude-sdk auth invalid: ${causeMessage}`, {
      kind: 'auth_invalid',
      cause,
    });
  }

  if (RATE_LIMIT.test(text)) {
    return new ServerClassifiedProviderError(`claude-sdk rate limit: ${causeMessage}`, {
      kind: 'rate_limit',
      cause,
    });
  }

  if (QUOTA.test(text)) {
    return new ServerClassifiedProviderError(`claude-sdk quota exhausted: ${causeMessage}`, {
      kind: 'quota_exhausted',
      cause,
    });
  }

  // The REST classifier knows the Anthropic error vocabulary (overloaded,
  // prompt too long, …); with no HTTP status it falls through to `transient`.
  return classifyClaudeServerError({ bodyText: text, cause });
}

/**
 * `resetsAt` is documented as epoch ms but Claude Code has been seen writing
 * epoch seconds (see minutesUntilReset in src/services/worker/RateLimitStore.ts,
 * whose heuristic this copies — src/server must not import from the worker).
 */
function retryAfterFromResetsAt(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  const resetsAtMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const delta = resetsAtMs - Date.now();
  return Math.min(Math.max(0, delta), MAX_RATE_LIMIT_RETRY_MS);
}
