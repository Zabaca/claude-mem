// Fleet: the render half of ContextBuilder, split out so the server runtime
// can inject the same timeline from Postgres rows. No `bun:sqlite` import may
// land here — ContextBuilder keeps the SQLite query half and calls in.
import type { ContextConfig, Observation, SessionSummary } from './types.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import { renderTimeline } from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection, renderFooter } from './sections/FooterRenderer.js';
import { renderAgentEmptyState } from './formatters/AgentFormatter.js';
import { renderHumanEmptyState } from './formatters/HumanFormatter.js';

export function renderEmptyState(project: string, forHuman: boolean): string {
  return forHuman ? renderHumanEmptyState(project) : renderAgentEmptyState(project);
}

export function buildContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  forHuman: boolean
): string {
  const output: string[] = [];

  const economics = calculateTokenEconomics(observations);

  output.push(...renderHeader(project, economics, config, forHuman));

  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, forHuman));

  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, forHuman));
  }

  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, forHuman));

  output.push(...renderFooter(economics, config, forHuman));

  return output.join('\n').trimEnd();
}

/**
 * Telemetry-facing shape of one context injection. Counts, booleans, and our
 * own enum strings only — computed from the same observation set that was
 * rendered, never from user content.
 */
export interface ContextInjectStats {
  observation_count: number;
  session_count: number;
  timeline_depth_days: number;
  has_session_summary: boolean;
  obs_type_bugfix: number;
  obs_type_discovery: number;
  obs_type_decision: number;
  obs_type_refactor: number;
  obs_type_other: number;
  tokens_injected: number;
  tokens_saved_vs_naive: number;
  search_strategy: string;
}

const STAT_TYPE_BUCKETS = new Set(['bugfix', 'discovery', 'decision', 'refactor']);

export function buildInjectStats(
  observations: Observation[],
  summaries: SessionSummary[],
  full: boolean
): ContextInjectStats {
  const economics = calculateTokenEconomics(observations);
  const typeCounts: Record<string, number> = {
    bugfix: 0, discovery: 0, decision: 0, refactor: 0, other: 0,
  };
  const sessionIds = new Set<string>();
  let oldestEpoch = Number.POSITIVE_INFINITY;
  for (const obs of observations) {
    const bucket = STAT_TYPE_BUCKETS.has(obs.type) ? obs.type : 'other';
    typeCounts[bucket]++;
    if (obs.memory_session_id) sessionIds.add(obs.memory_session_id);
    if (obs.created_at_epoch && obs.created_at_epoch < oldestEpoch) {
      oldestEpoch = obs.created_at_epoch;
    }
  }
  const timelineDepthDays = Number.isFinite(oldestEpoch)
    ? Math.max(0, Math.floor((Date.now() - oldestEpoch) / 86_400_000))
    : 0;

  return {
    observation_count: observations.length,
    session_count: sessionIds.size,
    timeline_depth_days: timelineDepthDays,
    has_session_summary: summaries.length > 0,
    obs_type_bugfix: typeCounts.bugfix,
    obs_type_discovery: typeCounts.discovery,
    obs_type_decision: typeCounts.decision,
    obs_type_refactor: typeCounts.refactor,
    obs_type_other: typeCounts.other,
    tokens_injected: economics.totalReadTokens,
    tokens_saved_vs_naive: economics.savings,
    search_strategy: full ? 'full' : 'timeline',
  };
}

/**
 * One call for a caller that already holds the rows: the worker's output for
 * the same rows, byte for byte. `cwd` is synthetic (`/context/<project>`) as
 * on the worker's inject route, so the "Previously" section — which reads a
 * local transcript — finds nothing.
 */
export function renderContext(
  config: ContextConfig,
  observations: Observation[],
  summaries: SessionSummary[],
  project: string,
  forHuman: boolean,
): { text: string; stats: ContextInjectStats | null } {
  if (observations.length === 0 && summaries.length === 0) {
    return { text: renderEmptyState(project, forHuman), stats: null };
  }
  const text = buildContextOutput(
    project,
    observations,
    summaries,
    config,
    `/context/${project}`,
    undefined,
    forHuman,
  );
  return { text, stats: buildInjectStats(observations, summaries, false) };
}
