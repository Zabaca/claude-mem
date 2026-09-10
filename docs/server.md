# Claude-Mem Server (Beta)

Claude-Mem Server is the beta server runtime for Claude-Mem 13. It is a
Postgres-backed, BullMQ-driven, API-key-authenticated runtime that replaces
the legacy `claude-mem worker` for deployable use cases.

## Architecture

```
                +-------------------+
                |  Hooks / SDK / MCP|
                |    (clients)      |
                +---------+---------+
                          |  HTTPS / Bearer API key
                          v
+-----------------+  +----+---------+   +-------------------+
|    Postgres     |<-+ claude-mem-  +-->+      Valkey       |
| (canonical      |  |   server      |   | (BullMQ queue,   |
|  storage:       |  | --daemon      |   |  noeviction,     |
|  events,        |  | HTTP only,    |   |  appendonly yes) |
|  observations,  |  | no generation |   +---------+---------+
|  jobs, sessions,|  +-------+-------+             ^
|  api_keys)      |          | enqueue              | poll
+--------^--------+          |                      |
         |                   v                      |
         |          +-----------------+             |
         +----------+ claude-mem-     +-------------+
            read    |  worker (Nx)    |  consume jobs
            write   | server worker   |  call provider
                    |  start          |
                    +-----------------+
```

The HTTP service and the BullMQ generation worker run from the **same image
and same codebase**, but are split into separate processes / containers so
that:

1. Long-running provider calls cannot block HTTP responsiveness.
2. Generation can scale horizontally (`docker compose up --scale claude-mem-worker=N`).
3. Restarting the HTTP server does not lose enqueued generation work — jobs
   live in Valkey, persisted by AOF.

The legacy `claude-mem worker` runtime is **not** spawned in Docker. The
container entrypoint runs `bun server-service.cjs --daemon` (or
`worker start`) and never `bun worker-service.cjs`.

## Required environment variables

`validateServerBetaEnv()` runs at startup and refuses to boot when any of
the following are missing or invalid in Docker:

| Variable                          | Required | Notes                                                        |
|-----------------------------------|----------|--------------------------------------------------------------|
| `CLAUDE_MEM_RUNTIME`              | Docker   | Must be `server-beta` in Docker (warned otherwise).          |
| `CLAUDE_MEM_QUEUE_ENGINE`         | Docker   | Must be `bullmq`. In-process queues are rejected in Docker.  |
| `CLAUDE_MEM_SERVER_DATABASE_URL`  | Always   | Postgres connection string. Fails fast at startup.           |
| `CLAUDE_MEM_REDIS_URL`            | bullmq   | Required when queue engine is `bullmq`.                      |
| `CLAUDE_MEM_AUTH_MODE`            | Always   | Must NOT be `local-dev` in Docker.                           |
| `CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS` | Docker | Must NOT be `1`/`true` in Docker.                            |
| `CLAUDE_MEM_GENERATION_DISABLED`  | Optional | Set to `true` on the HTTP service when running a separate worker. |
| `CLAUDE_MEM_SERVER_PROVIDER`      | Worker   | One of `claude`, `claude-sdk`, `gemini`, `openrouter`. Worker only. |
| `ANTHROPIC_API_KEY` (or alt)      | Worker   | Required by the `claude`, `gemini` and `openrouter` providers. |
| `CLAUDE_CODE_OAUTH_TOKEN`         | Worker   | `claude-sdk` only: subscription token from `claude setup-token`. A credentials file (`CLAUDE_MEM_CREDENTIALS_FILE`) works too; without either the worker warns at startup. |
| `CLAUDE_MEM_SERVER_MODEL`         | Optional | Model id for the chosen provider. `claude-sdk` defaults to `claude-haiku-4-5-20251001`. |
| `CLAUDE_MEM_SERVER_SDK_TIMEOUT_MS`| Optional | `claude-sdk` only: per-job CLI timeout, default 120000. Keep it under the 5-minute job lock. |
| `CLAUDE_MEM_SERVER_CLAUDE_PATH`   | Optional | `claude-sdk` only: path to the `claude` CLI. Defaults to the same discovery the worker runtime uses. |

### The `claude-sdk` provider

`CLAUDE_MEM_SERVER_PROVIDER=claude-sdk` generates observations through the
Claude Code CLI (via the Claude Agent SDK) rather than a direct Messages API
call, so a Claude subscription's OAuth token authenticates it — no API key.
Each job spawns the CLI once with no tools, no settings sources, thinking off
and auto-memory off, which is roughly 124 tokens of overhead on top of the
prompt. The default model is `claude-haiku-4-5-20251001`: this is an
extraction task, and the local worker's default is haiku for the same reason.
The worker logs a warning at startup when it can see no credential at all
(no `CLAUDE_CODE_OAUTH_TOKEN`, no credentials file, no
`~/.claude/.credentials.json`) — on a Mac the login Keychain still works, so
it is a warning, not a failure. Only `transient` and `rate_limit` errors retry;
a rejected subscription rate limit carries its reset time as the retry delay,
capped at six hours.

Local development can still use SQLite + `local-dev` auth bypass **outside
Docker only**. Deployable mode must use the table above.

## Fleet endpoints: per-repo projects and recent-context injection

Upstream's server lane covers writes only: hooks send every event to one static
`CLAUDE_MEM_SERVER_PROJECT_ID`, and the SessionStart hook always asks the local
worker for context. The fork closes that gap.

- `POST /v1/projects/resolve` (write scope) — body `{ names: string[1..8] }`. Get-or-creates
  projects by name within the key's team and returns `{ projects: [{ id, name }] }` in request
  order. Hooks call it once per repo (the names `getProjectContext` gives: parent and
  worktree) and cache the ids in `~/.claude-mem/server-projects.json` (0600). Leave
  `CLAUDE_MEM_SERVER_PROJECT_ID` empty to bucket per repo; set it to pin one project.
- `POST /v1/context/recent` (read scope) — body `{ projects: string[1..8], platformSource?,
  colors? }`. The worker's `GET /api/context/inject`, on Postgres: newest observations and
  session summaries across the named projects, filtered by the active mode, rendered by the
  same code as the worker. Unknown names are empty; nothing is created on a read. Returns
  `{ context, stats }`.
- `GET /v1/observations/latest` (read scope) — `{ createdAt, count }` for the team; a cheap
  "is it storing" signal for monitoring.

Team-scoped keys: `server api-key create --team <id> --team-scoped --name <client>` mints a key
with no project so it may act on every project in its team. The name is kept (as the key's
actor id), shown by `api-key list`, and `api-key revoke --name <client>` revokes every active
key of that name.

`CLAUDE_MEM_SERVER_WORKER_FALLBACK=false` (client settings) turns off the fall-through to the
local worker when the server is unreachable: a fleet client then logs a hook failure instead
of writing into a local SQLite nobody reads. `worker-service.cjs start` is a no-op when
`CLAUDE_MEM_RUNTIME=server`, so no worker or Chroma is spawned on such a client.

## Generation worker mode (`claude-mem server worker start`)

The same image runs the generation worker via:

```sh
claude-mem server worker start
```

This starts a process that:

* Connects to Postgres and Valkey using the same configuration as the HTTP
  service.
* Attaches BullMQ Workers to the `event` and `summary` queues.
* Never opens an HTTP listener.
* Blocks in the foreground (good for `docker run`, `kubectl run`, systemd).
* Forces generation enabled even if `CLAUDE_MEM_GENERATION_DISABLED=true`
  is inherited from the shared compose file. The worker IS the generation
  process.

In Compose this is the `claude-mem-worker` service. Scale it horizontally:

```sh
docker compose up -d --scale claude-mem-worker=4
```

BullMQ guarantees only one worker processes a given job at a time; the
provider call inside `ProviderObservationGenerator.process` is idempotent
on the `job.id` (`evt_<sha256>` / `sum_<sha256>`) so retries cannot
duplicate observations.

## Auth in production

```sh
CLAUDE_MEM_AUTH_MODE=api-key
```

API keys are created with:

```sh
claude-mem server api-key create \
  --name "ci"                  \
  --scope memories:read,memories:write
```

The raw key is shown **once**; only a SHA-256 hash is stored in Postgres
(`api_keys.key_hash`). Revoke with:

```sh
claude-mem server api-key revoke <id>
```

Revocation is enforced on every request because `requirePostgresServerAuth`
reloads the row by hash on each call. There is no in-memory cache to
poison.

> **Do not enable `CLAUDE_MEM_AUTH_MODE=local-dev` in Docker.** The
> loopback bypass relies on the request originating from `127.0.0.1` on
> the HTTP listener, which is not a meaningful boundary inside a
> container. The startup validator refuses to boot with this combination
> and returns a non-zero exit code.

## Compose stack

`docker-compose.yml` ships four services:

* `postgres` — canonical storage. Schema is bootstrapped at startup by
  `bootstrapServerBetaPostgresSchema()`.
* `valkey` — BullMQ queue, configured with `appendonly yes`,
  `appendfsync everysec`, `maxmemory-policy noeviction`.
* `claude-mem-server` — HTTP runtime.
  `CLAUDE_MEM_GENERATION_DISABLED=true` so the BullMQ Worker is **not**
  attached here.
* `claude-mem-worker` — generation worker. Scale horizontally.

Bring it up:

```sh
docker compose up -d --build
```

Tear it down (and wipe data):

```sh
docker compose down -v
```

## End-to-end test

`scripts/e2e-server-docker.sh` brings up the full stack and verifies:

* `POST /v1/events?wait=true` returns a `generationJob` descriptor.
* Restart of `claude-mem-server` and `claude-mem-worker` mid-stream does
  not lose data.
* Revoking an API key denies subsequent reads and writes (401/403).
* No `worker-service.cjs` process runs in any container.
* `CLAUDE_MEM_AUTH_MODE=local-dev` is rejected inside Docker.
