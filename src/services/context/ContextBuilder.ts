
import path from 'path';
import { homedir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../sqlite/connection.js';

import type { ContextInput } from './types.js';
import { colors } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import {
  queryObservationsMulti,
  querySummariesMulti,
} from './ObservationCompiler.js';
import {
  buildContextOutput,
  buildInjectStats,
  renderEmptyState,
  type ContextInjectStats,
} from './render.js';
export type { ContextInjectStats } from './render.js';
import {
  readObserverHealth,
  isObserverUnhealthy,
  renderObserverHealthWarning,
} from '../../shared/observer-health.js';

const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'thedotmack',
  'plugin',
  '.install-version'
);

function initializeDatabase(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true, create: false });
    try {
      db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        if (unlinkError instanceof Error) {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', {}, unlinkError);
        } else {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', { error: String(unlinkError) });
        }
      }
      logger.error('WORKER', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

/**
 * Paint every non-blank line, rather than wrapping the block once: session
 * context is long enough to scroll, and a single leading escape leaves the
 * warning uncolored wherever the terminal reflows or the reader scrolls back.
 */
function paintRed(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `${colors.red}${line}${colors.reset}` : line))
    .join('\n');
}

/**
 * Append the observer-health outage warning when the observer is failing.
 * Applied to EVERY context path (including empty-state, missing-DB, and the
 * no-memories-yet welcome hint in SearchRoutes) so the outage is surfaced even
 * when there is nothing else to render.
 *
 * BELOW the context, not above it: the timeline runs long, so a warning at the
 * top has already scrolled off by the time the context finishes printing. The
 * last thing rendered is the thing still on screen — and for the model, the
 * closest thing to its first reply.
 */
export function withObserverHealthWarning(text: string, forHuman: boolean = false): string {
  const health = readObserverHealth();
  if (!isObserverUnhealthy(health)) {
    return text;
  }
  const warning = renderObserverHealthWarning(health);
  // Colors only on the human render: the agent copy is fetched separately
  // (colors=false) and ANSI escapes there are noise in the model's context.
  const rendered = forHuman ? paintRed(warning) : warning;
  return text ? `${text}\n\n${rendered}` : rendered;
}

export async function generateContextWithStats(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<{ text: string; stats: ContextInjectStats | null }> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const context = getProjectContext(cwd);

  const projects = input?.projects?.length ? input.projects : context.allProjects;
  const project = projects[projects.length - 1] ?? context.primary;

  if (input?.full) {
    config.totalObservationCount = 999999;
    config.sessionCount = 999999;
  }

  const rawDb = initializeDatabase();
  if (!rawDb) {
    return { text: withObserverHealthWarning('', forHuman), stats: null };
  }

  try {
    const db = { db: rawDb };
    const platformSource = input?.platformSource
      ? normalizePlatformSource(input.platformSource)
      : undefined;
    const queryProjects = projects.length > 1 ? projects : [project];
    const observations = queryObservationsMulti(db, queryProjects, config, platformSource);
    const summaries = querySummariesMulti(db, queryProjects, config, platformSource);

    if (observations.length === 0 && summaries.length === 0) {
      return { text: withObserverHealthWarning(renderEmptyState(project, forHuman), forHuman), stats: null };
    }

    const output = buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      forHuman
    );

    return {
      text: withObserverHealthWarning(output, forHuman),
      stats: buildInjectStats(observations, summaries, Boolean(input?.full)),
    };
  } finally {
    rawDb.close();
  }
}

export async function generateContext(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<string> {
  return (await generateContextWithStats(input, forHuman)).text;
}
