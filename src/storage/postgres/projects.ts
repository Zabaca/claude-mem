// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject } from './utils.js';

export interface PostgresProject {
  id: string;
  teamId: string;
  name: string;
  metadata: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface ProjectRow {
  id: string;
  team_id: string;
  name: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresProjectsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    teamId: string;
    name: string;
    metadata?: JsonObject;
  }): Promise<PostgresProject> {
    const id = input.id ?? newId();
    const row = await queryOne<ProjectRow>(
      this.client,
      `
        INSERT INTO projects (id, team_id, name, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `,
      [id, input.teamId, input.name, JSON.stringify(input.metadata ?? {})]
    );
    return mapProjectRow(row!);
  }

  // Fleet: get-or-create projects by name, one statement per name so two
  // hooks racing on a new repo cannot both insert. The ON CONFLICT update is
  // what makes the RETURNING row appear for the existing project too.
  async resolveByNames(input: {
    teamId: string;
    names: string[];
  }): Promise<Array<{ id: string; name: string }>> {
    const out: Array<{ id: string; name: string }> = [];
    for (const name of input.names) {
      const row = await queryOne<{ id: string; name: string }>(
        this.client,
        `
          INSERT INTO projects (id, team_id, name, metadata)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (team_id, name) DO UPDATE SET updated_at = now()
          RETURNING id, name
        `,
        [newId(), input.teamId, name, JSON.stringify({ source: 'fleet-client' })]
      );
      out.push({ id: row!.id, name: row!.name });
    }
    return out;
  }

  // Lookup only: unknown names are left out, nothing is created.
  async findByNames(input: {
    teamId: string;
    names: string[];
  }): Promise<Array<{ id: string; name: string }>> {
    if (input.names.length === 0) return [];
    const result = await this.client.query<{ id: string; name: string }>(
      'SELECT id, name FROM projects WHERE team_id = $1 AND name = ANY($2::text[])',
      [input.teamId, input.names]
    );
    return result.rows.map(row => ({ id: row.id, name: row.name }));
  }

  async getByIdForTeam(id: string, teamId: string): Promise<PostgresProject | null> {
    const row = await queryOne<ProjectRow>(
      this.client,
      'SELECT * FROM projects WHERE id = $1 AND team_id = $2',
      [id, teamId]
    );
    return row ? mapProjectRow(row) : null;
  }
}

function mapProjectRow(row: ProjectRow): PostgresProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}
