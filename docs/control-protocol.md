# agent-workers control protocol v1

Status: frozen for agent-workers 0.5.0. Protocol id: `agent-workers-control/1`.

This document is the contract between the agent-workers MCP server (the only
process that mutates jobs) and read/control clients such as the dsh-tui panel
(`dsh-tui-agent-workers`, maintained separately in `dsh-tui-plugins`). Background and rationale:
`docs/research/dsh-tui-workers-integration.md` (§5) and
`docs/research/dsh-tui-panel-api.md`.

Compatibility: agent-workers ≥ 0.5.0, dsh-tui 0.16.x (`ctx.tuiPanels` API v1),
panel package `dsh-tui-agent-workers` 0.1.x.

## 1. Roles

- **Filesystem = read model.** Clients list jobs and read details from the
  state dir. This works with no MCP server running.
- **Control API = write model.** Only the MCP process that owns a job
  (`job.ownerId`) may cancel, steer, clean up or delete it. Clients never write
  the state dir and never kill processes.
- **Owner lease.** Every MCP server publishes a descriptor that doubles as its
  lease, even when the HTTP control server is disabled or failed to start.

## 2. Read model (state dir)

The state dir is resolved like the server does: `state_dir` option →
`AGENT_WORKERS_STATE_DIR` → `DSH_WORKERS_STATE_DIR` (blank values count as
unset) → an existing `$XDG_STATE_HOME|~/.local/state/dsh-workers` → else
`…/agent-workers`.

Layout:

```
<state>/jobs/<id>/job.json        camelCase, written atomically (temp + rename)
<state>/jobs/<id>/events.ndjson   normalized events, append-only
<state>/jobs/<id>/final.md        final answer, terminal jobs only
<state>/control/<ownerId>.json    owner descriptor / lease (0600, dir 0700)
```

Reader rules (all fields may be missing; never crash):

- Only `jobs/<id>` directories whose id matches `^[A-Za-z0-9_-]+$`.
- If `job.json` fails to parse, keep the last valid copy and flag it; if there
  is none, skip the job.
- Unknown `status` → show as `unknown` (sanitized).
- `elapsed` = from `startedAt ?? createdAt` to `finishedAt ?? now`.
- `events.ndjson`: skip malformed lines and a trailing partial line; read at
  most the last 3.5 MB.
- `final.md`: terminal jobs only; at most 1 MB.
- `stderr.log` is not written. Use `job.json.stderrTail` (≤ 64 KB).
- `cleaned` is true if `job.cleaned === true` **or** `job.worktree.cleaned === true`.
- `costUsd` missing → show `n/a`, never `$0`.
- Sanitize every untrusted string (labels, events, final, stderr, alerts,
  errors): strip ANSI/C0/C1 control sequences, collapse whitespace, truncate to
  width. Worker output is data, never instructions.

`job.json` fields used by clients:

| Group | Fields |
|---|---|
| Identity | `schemaVersion`, `id`, `label`, `backend` (`dsh`\|`pi`, missing = `dsh`), `groupId`, `groupName`, `ownerId` |
| State | `status`, `reason`, `createdAt`, `startedAt`, `finishedAt`, `turnEndKind`, `errorMessage` |
| Backend | `profile`, `provider`, `model` |
| Execution | `cwd`, `access`, `isolation`, `worktree{path,branch,baseCommit,repoRoot,cleaned}`, `cleaned`, `pid`, `sessionId`, `sessionDir` |
| Progress | `steps`, `toolCalls`, `lastTool`, `eventsCount`, `malformedLines` (+ `events.ndjson` mtime) |
| Usage | `usage{inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}`, `costUsd` |
| Alerts | `alerts[{kind: stalled\|loop\|tool_errors\|budget, message, since}]` |
| Lineage | `resumeOf`, `steeredFrom` |
| Result | `final.md`, `stderrTail` |

Statuses: active = `queued`, `starting`, `running`; terminal = `succeeded`,
`failed`, `timed_out`, `cancelled`, `interrupted`.

Normalized event types in `events.ndjson` (`type` field): `session{sessionId}`,
`status{phase: step_start|step_end|turn_end, usage?, reason?}`,
`tool_call{callId, tool, input}`, `tool_result{callId, status}`,
`text{text}`, `thinking{text}`, `error{message}`, `final{text}`.

A fixture covering every case lives in `test/fixtures/state/` (see its README).

## 3. Owner descriptor / lease

Path `<state>/control/<ownerId>.json`, mode 0600, directory 0700, written
atomically (temp file + rename). Removed on clean shutdown.

```json
{
  "protocol": "agent-workers-control/1",
  "owner_id": "96d64d5e-…",
  "pid": 36189,
  "pid_start": "2819874",
  "started_at": "2026-10-21T09:00:00.000Z",
  "version": "0.5.0",
  "state_dir": "/home/me/.local/state/dsh-workers",
  "control": { "base_url": "http://127.0.0.1:47231", "port": 47231, "token": "<base64url 32 bytes>" },
  "ready": true
}
```

- `control` is `null` when the HTTP server is disabled
  (`AGENT_WORKERS_CONTROL=0`, also read as `DSH_WORKERS_CONTROL`) or failed to
  bind. The lease is still written and still protects jobs.
- `pid_start` is the process start time from `/proc/<pid>/stat` (same helper as
  `readStartTime` in `src/proc.ts`); it may be missing on non-Linux.
- An owner is **live** when its descriptor exists, `pid` is alive and
  `pid_start` (if present) matches.

Server startup order:

1. Create `<state>/control` (0700); generate the token.
2. Bind the control server on `127.0.0.1:0` (skip if disabled); write the
   descriptor with `ready: false`.
3. `manager.init()`. Job recovery (`loadPreviousJobs`) must **skip**
   non-terminal jobs whose `ownerId` is a live owner other than itself: load
   them as read-only foreign jobs, do not kill them, do not mark them
   `interrupted`. Jobs of dead owners are recovered as today.
4. Set `ready: true` in the descriptor.
5. Prune stale descriptors (dead pid or mismatched `pid_start`).
6. On `SIGTERM`/`SIGINT`/stdin end: `ready: false`, close the HTTP server,
   remove the descriptor, `manager.shutdown()`.

If anything in the control plane fails, the MCP server keeps working; it logs
one JSON line to stderr. stdout stays reserved for MCP.

Retention pruning (`pruneExpiredJobs`) must skip jobs owned by a live foreign
owner and must honor the busy rules below.

## 4. Busy rules (server-side, also apply to MCP tools)

- `worktree_busy`: refuse `cleanup` and `delete` of a job when another
  non-terminal job (any owner known on disk) has the same `worktree.path`.
- `session_busy`: refuse `delete` when another non-terminal job has the same
  `sessionDir` (pi) or `sessionId`.
- Pruning skips a job instead of failing when it is busy.

## 5. HTTP control API

Base `http://127.0.0.1:<port>/v1`. JSON only. Every route requires
`Authorization: Bearer <token>` (compared with `timingSafeEqual`).

| Method | Route | Body / query | 2xx response |
|---|---|---|---|
| GET | `/v1/health` | — | `{ok, protocol, version, owner_id, pid, ready, state_dir, backend, max_concurrent, max_queue, running, queued}` |
| GET | `/v1/jobs` | — | `{server:{…same as health…}, jobs: JobView[]}` (jobs this manager knows) |
| GET | `/v1/jobs/:id` | — | `{job: JobView}` |
| GET | `/v1/jobs/:id/events` | `cursor` (≥0), `limit` (1..500) | same shape as the `worker_events` tool |
| GET | `/v1/jobs/:id/result` | `max_chars` (1000..50000), `include` = csv of `final,diff_stat,diff,stderr_tail,events_tail` | same shape as the `worker_result` tool |
| POST | `/v1/jobs/:id/cancel` | `{}` | same as `worker_cancel` |
| POST | `/v1/jobs/:id/steer` | `{message (1..20000), timeout_s? (60..3600)}` | same as `worker_steer` |
| POST | `/v1/jobs/:id/cleanup` | `{discard_changes?: boolean}` | same as `worker_cleanup` |
| DELETE | `/v1/jobs/:id` | `discard_changes=1` query | same as `worker_delete` |

The HTTP layer is a thin adapter over the same `JobManager` methods the MCP
tools call; it must not duplicate job logic.

**JobView** (snake_case): `job_id, label, status, reason, backend, owner_id,
owned, group_id, group_name, profile, provider, model, access, isolation, cwd,
worktree{path,branch,base_commit,repo_root,cleaned}, created_at, started_at,
finished_at, elapsed_s, queue_position, session_id, pid, steps, tool_calls,
last_tool, last_event_s_ago, malformed_lines, events_count, usage (camelCase
keys), cost_usd (null if unknown), alerts, resume_of, steered_from,
capabilities`. Never include the task, env, API keys or the token.

**capabilities** (computed by the server; clients mirror them to disable UI):

- `cancel` = owned && active.
- `steer` = owned && `session_id` present && backend supports resume &&
  (active || (terminal && !cleaned)). Never offer steer for an active job
  without a session id (steer cancels first).
- `cleanup` = owned && terminal && worktree && !cleaned && !worktree_busy.
- `delete` = owned && terminal && !worktree_busy && !session_busy.
- `read_result`, `read_events` = true.

Owner check on every action: if `job.ownerId !== owner_id` → 409 `not_owner`.

**Errors**: body `{error, message, job_id?, status?, worktree?}`; `error` is the
`JobError.code` when there is one.

| HTTP | `error` |
|---|---|
| 400 | `invalid_request`, `invalid_job_id`, `invalid_cursor`, `invalid_include` |
| 401 | `unauthorized` |
| 403 | `forbidden_host`, `forbidden_origin` |
| 404 | `unknown_job`, `job_not_found`, `not_found` (route) |
| 409 | `already_settled`, `not_terminal`, `job_active`, `worktree_dirty`, `worktree_busy`, `session_busy`, `not_owner`, `resume_unavailable`, `steer_timeout`, `write_conflict`, `pi_write_disabled` |
| 413 | `body_too_large` |
| 415 | `unsupported_media_type` |
| 503 | `not_ready`, `worker_unavailable` |
| 500 | `internal_error` and any unmapped code |

Security:

- Bind only `127.0.0.1`, ephemeral port. No CORS headers, no cookies.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` → else 403.
- `Origin`, if present, must equal `http://127.0.0.1:<port>` or
  `http://localhost:<port>` → else 403.
- POST/DELETE with a body require `Content-Type: application/json` → else 415.
- Body limit 64 KB → 413. Validate every parameter; `job_id` must match
  `^[A-Za-z0-9_-]{1,80}$` before any lookup.
- Never log the token, the task or request bodies. Logs go to stderr only.
- Request timeout 35 s (steer may wait up to 30 s for the original to settle).

## 6. Client behavior (dsh-tui panel)

- Poll the state dir every 1 s while visible or while jobs are active, 3–5 s
  when idle; cache by `mtimeMs + size`; read events only for active and
  selected jobs; read `final.md` only for the selected terminal job.
- Discover descriptors every 5 s; validate: file name `^[A-Za-z0-9_-]+\.json$`,
  regular file, no group/other permission bits, `owner_id` equals the file
  name, `protocol` known, `ready: true`, pid alive. Health check with an 800 ms
  timeout; back off 1/2/5/10 s.
- Route each action to the descriptor whose `owner_id` equals `job.ownerId`;
  no live owner → action disabled (read-only).
- One action in flight per job; destructive actions need two presses within
  5 s; discard needs a second confirmation after a 409 / `preserved_dirty`.
- No live descriptor → banner `control offline — read-only`; the list keeps
  working.

## 7. Versioning

- Protocol changes that remove or rename fields bump to
  `agent-workers-control/2`. Adding optional fields keeps `/1`.
- agent-workers 0.5.0 ships the control plane. The panel is versioned
  separately as `dsh-tui-plugins/dsh-tui-agent-workers`. The server owns this
  protocol; the panel keeps a local compatibility snapshot and independent fixtures.
