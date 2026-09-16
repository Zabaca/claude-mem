// SPDX-License-Identifier: Apache-2.0
//
// Fleet: the MCP `search` tool on the server runtime. Upstream sent a bare
// query to /v1/search under the one pinned CLAUDE_MEM_SERVER_PROJECT_ID and
// every filtered query to the local worker's SQLite, which under the server
// runtime holds nothing. This resolves the project the way the hooks do and
// maps the tool's filters onto /v1/search, so nothing falls back.

import { ServerClientError, type ServerSearchObservationsRequest } from './server-client.js';
import type { ServerRuntimeContext } from './runtime-selector.js';
import { resolveServerProjectId } from './server-project.js';

const SEARCH_ORDER_BY = new Set(['rank', 'date_desc', 'date_asc']);

function searchDateEpoch(value: unknown, field: string, endOfDay: boolean): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const epoch = Date.parse(dayOnly ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  if (Number.isNaN(epoch)) {
    throw new ServerClientError('invalid_response', `search: ${field} is not an ISO date: "${text}"`);
  }
  return epoch;
}

export async function buildServerSearchRequest(
  runtime: ServerRuntimeContext,
  args: Record<string, unknown>,
  options: { cwd?: string; cacheFile?: string } = {},
): Promise<ServerSearchObservationsRequest> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    throw new ServerClientError('invalid_response', 'search: query is required on the server runtime');
  }
  const type = args.type === undefined || args.type === null || args.type === '' ? undefined : String(args.type);
  if (type === 'sessions' || type === 'prompts') {
    throw new ServerClientError('invalid_response', `search: type "${type}" is not on the server; only observations are searchable there`);
  }
  // Any other `type` is an observation-kind filter, per the tool's contract.
  const kinds = [type !== undefined && type !== 'observations' ? type : '', typeof args.obs_type === 'string' ? args.obs_type : '']
    .join(',').split(',').map(k => k.trim()).filter(Boolean);
  const orderBy = args.orderBy === undefined || args.orderBy === null || args.orderBy === '' ? undefined : String(args.orderBy);
  if (orderBy !== undefined && !SEARCH_ORDER_BY.has(orderBy)) {
    throw new ServerClientError('invalid_response', `search: orderBy must be one of ${[...SEARCH_ORDER_BY].join(', ')}`);
  }
  let projectId: string;
  if (typeof args.project === 'string' && args.project.trim()) {
    const name = args.project.trim();
    const resolved = await runtime.client.resolveProjects([name]);
    const id = resolved.projects.find(p => p.name === name)?.id;
    if (!id) throw new ServerClientError('invalid_response', `search: server did not resolve project "${name}"`);
    projectId = id;
  } else {
    projectId = await resolveServerProjectId(runtime, options.cwd ?? process.cwd(), options.cacheFile ? { cacheFile: options.cacheFile } : {});
  }
  const dateStartEpoch = searchDateEpoch(args.dateStart, 'dateStart', false);
  const dateEndEpoch = searchDateEpoch(args.dateEnd, 'dateEnd', true);
  return {
    projectId,
    query,
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
    ...(typeof args.platformSource === 'string' && args.platformSource ? { platformSource: args.platformSource } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(dateStartEpoch !== undefined ? { dateStartEpoch } : {}),
    ...(dateEndEpoch !== undefined ? { dateEndEpoch } : {}),
    ...(orderBy !== undefined ? { orderBy: orderBy as 'rank' | 'date_desc' | 'date_asc' } : {}),
  };
}
