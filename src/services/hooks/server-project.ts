// SPDX-License-Identifier: Apache-2.0
//
// Fleet: per-repo project ids for the server runtime. Upstream bound every
// hook to one static CLAUDE_MEM_SERVER_PROJECT_ID; the fleet buckets by
// repo the way the local worker does (`getProjectContext`), so a hook asks
// the server for the id of its cwd's project once and caches it. Hooks are
// separate processes, hence a file cache rather than a module variable.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { DATA_DIR } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import type { ServerRuntimeContext } from './runtime-selector.js';

export const SERVER_PROJECTS_CACHE_PATH = path.join(DATA_DIR, 'server-projects.json');

type Cache = Record<string, Record<string, string>>;

function readCache(file: string): Cache {
  try {
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Cache) : {};
  } catch (error) {
    logger.warn('HOOK', 'server-projects cache unreadable; ignoring', { file, error: String(error) });
    return {};
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    logger.warn('HOOK', 'server-projects cache not written', { file, error: String(error) });
  }
}

/**
 * The server project id a hook should write under for `cwd`: the fixed id
 * when the settings pin one, else the repo's primary project name resolved
 * (and created) on the server, cached per server URL.
 */
export async function resolveServerProjectId(
  runtime: ServerRuntimeContext,
  cwd: string,
  options: { cacheFile?: string } = {},
): Promise<string> {
  if (runtime.projectId) return runtime.projectId;
  const name = getProjectContext(cwd).primary;
  const file = options.cacheFile ?? SERVER_PROJECTS_CACHE_PATH;
  const cache = readCache(file);
  const cached = cache[runtime.serverBaseUrl]?.[name];
  if (cached) return cached;
  const result = await runtime.client.resolveProjects([name]);
  const id = result.projects.find(p => p.name === name)?.id;
  if (!id) {
    throw new Error(`server did not resolve project "${name}"`);
  }
  cache[runtime.serverBaseUrl] = { ...(cache[runtime.serverBaseUrl] ?? {}), [name]: id };
  writeCache(file, cache);
  return id;
}
