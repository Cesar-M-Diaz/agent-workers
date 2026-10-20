# dsh-workers

A standalone local stdio MCP server, live dashboard, Claude Code skill, and slash
commands for running DeepSeek Harness (`dsh`) headless workers in parallel.

This is an independent personal project. It is not an official DeepSeek package
and is not part of N|Solid or NodeSource.

The server uses one `dsh --profile <profile> --json` process per job. It provides
a bounded FIFO queue, wall-clock timeouts, process-group cancellation, optional
git worktree isolation, session grouping, artifact-based results, automatic
retention for terminal jobs, pure heuristic watchdogs, and session steering
through `dsh_steer`.

```text
Claude Code / Codex
  └── MCP "dsh-workers"
        └── one dsh --profile <profile> --json process per job
              └── provider/model from the dsh profile
```

These workers are separate DSH processes. They are not Claude `Task` calls and
do not appear in the DSH TUI native subagent side panel.

## Requirements

- Node 24+
- pnpm 10+
- `dsh` and a DeepSeek, OpenRouter or OpenCode Go credential available to the worker process
- Writable state and DSH home directories

## Build and test

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Live dashboard

The standalone dashboard reads the shared worker state directory and streams
job updates over Server-Sent Events. It is read-only and binds to loopback only.

```sh
pnpm build
node dist/ui.js
```

Open:

```text
http://127.0.0.1:47100
```

Start it in the background and open a browser:

```sh
node dist/ui.js --detach --open
```

Control the background dashboard:

```sh
node dist/ui.js --status
node dist/ui.js --stop
```

Focus one job:

```sh
node dist/ui.js --detach --open --job j_abc123
```

The dashboard groups jobs by parent session, shows status, steps, tool calls,
thinking, assistant text, tool results, final answer, token usage, estimated USD
cost, elapsed time, and current watchdog alerts. Usage is broken down into input,
output, cache reads and cache writes; the cost is estimated from the run's
provider/model metadata. Terminal jobs can be deleted from the job header. A
dirty worktree requires a second confirmation before its changes are discarded.
Cancellation remains an MCP operation.

The dashboard is not the DSH TUI side panel. The TUI side panel belongs to an
interactive DSH session; these workers are separate headless DSH processes.

## Headless credentials

The worker profiles disable the DSH managed credential store. A worker can
receive `DEEPSEEK_API_KEY`, `OPENROUTER_CHAT_API_KEY` or `OPENCODE_GO_API_KEY`
explicitly, or read the references from the DSH credential store when
`DSH_WORKERS_USE_DSH_CREDENTIALS=1`. The worker profile decides which provider
and model the worker uses.

## Worker profiles

Profiles live under `$DSH_WORKERS_DSH_HOME/profiles`. The server starts in
`DSH_WORKERS_PROFILE` (default `work-openrouter`, falling back to `headless`),
and `dsh_profile` switches the profile for the current MCP session. `dsh_start`
also accepts `profile` for a single job; existing jobs keep their profile,
including when resumed.

The local setup uses three profiles:

| Profile | Provider | Model | Credential |
| --- | --- | --- | --- |
| `work-openrouter` | `openrouter` | `~deepseek/deepseek-flash-latest` | `OPENROUTER_CHAT_API_KEY` |
| `personal-deepseek` | `deepseek-official` | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| `personal-opencode` | `opencode-go` | `deepseek-v4.1-flash` | `OPENCODE_GO_API_KEY` |

`personal-opencode` also registers `glm-5.3-flash`. Create more directories
with the same files (including `metadata.json`) to add profiles; `dsh_profile` lists them dynamically.

Each profile also has a `metadata.json` with its `provider` and `model`. The
server copies that metadata into every job so the dashboard can estimate cost;
keep it in sync with `cordis.patch.yml` when changing the model.

## MCP configuration

The MCP server is normally installed at user scope so every Claude Code project
can use it. Example configuration:

```json
{
  "mcpServers": {
    "dsh-workers": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/home/cesardiaz/projects/dsh-workers/dist/server.js"
      ],
      "env": {
        "DSH_WORKERS_DSH_BIN": "/home/cesardiaz/.volta/bin/dsh",
        "DSH_WORKERS_ALLOWED_ROOTS": "/home/cesardiaz/NodeSource",
        "DSH_WORKERS_STATE_DIR": "/home/cesardiaz/.local/state/dsh-workers",
        "DSH_WORKERS_WORKTREE_ROOT": "/home/cesardiaz/.local/state/dsh-workers/worktrees",
        "DSH_WORKERS_DSH_HOME": "/home/cesardiaz/.local/state/dsh-workers/dsh-home",
        "DSH_WORKERS_USE_DSH_CREDENTIALS": "1"
      }
    }
  }
}
```

With the Claude Code CLI:

```sh
claude mcp add dsh-workers --scope user \
  --env DSH_WORKERS_DSH_BIN=/home/cesardiaz/.volta/bin/dsh \
  --env DSH_WORKERS_ALLOWED_ROOTS=/home/cesardiaz/NodeSource \
  --env DSH_WORKERS_STATE_DIR=/home/cesardiaz/.local/state/dsh-workers \
  --env DSH_WORKERS_WORKTREE_ROOT=/home/cesardiaz/.local/state/dsh-workers/worktrees \
  --env DSH_WORKERS_DSH_HOME=/home/cesardiaz/.local/state/dsh-workers/dsh-home \
  --env DSH_WORKERS_USE_DSH_CREDENTIALS=1 \
  -- node /home/cesardiaz/projects/dsh-workers/dist/server.js
```

Restart Claude Code after changing MCP configuration.

## Claude skill

Install the bundled skill at user scope:

```sh
mkdir -p ~/.claude/skills/dsh-parallel
cp skill/SKILL.md ~/.claude/skills/dsh-parallel/SKILL.md
```

Alternatively, copy `skill/SKILL.md` into a project:

```text
.claude/skills/dsh-parallel/SKILL.md
```

## Claude slash commands

The repository ships global Claude Code commands under `claude/commands/`:

```sh
pnpm install:claude-commands
```

or, directly:

```sh
bash scripts/install-claude-commands.sh
```

Commands installed under `~/.claude/commands/`:

| Command | Purpose |
| --- | --- |
| `/dsh-start <task>` | Start one self-contained DSH worker. |
| `/dsh-status [job ...]` | Show worker status and progress counters. |
| `/dsh-events <job> [cursor]` | Read a cursor-based page of live step events. |
| `/dsh-wait <job ...>` | Wait for jobs with a bounded timeout. |
| `/dsh-result <job>` | Read final answer, tails, and worktree changes. |
| `/dsh-cancel <job>` | Cancel a queued or running worker. |
| `/dsh-steer <job> <message>` | Cancel if active and resume the session with a corrective instruction. |
| `/dsh-cleanup <job>` | Clean up a terminal worktree. |
| `/dsh-delete <job>` | Delete a terminal job record and its files. |
| `/dsh-ui [start\|stop\|status\|restart]` | Control the live dashboard. |
| `/dsh-watch <job>` | Open the dashboard focused on one job. |

Custom Claude commands are prompt templates: they instruct Claude to call the
MCP tools; they do not bypass the model or the MCP permission rules. The MCP
server can also expose MCP prompts, but these named Markdown commands provide
clean `/dsh-*` names.

Restart Claude Code or start a new session after installing commands.

## Job lifecycle and deletion

- A terminal job record is kept for `DSH_WORKERS_RETENTION_DAYS` days
  (default `7`).
- Automatic retention never deletes a job with a dirty worktree or commits that
  are not reachable from the base revision. Those records stay until review.
- The dashboard's **Delete** button deletes a terminal job and its logs.
- If the job has a clean worktree, deleting the job also removes the worktree
  and branch.
- If the worktree is dirty or contains commits beyond its base, the first delete
  attempt is refused; confirming the discard prompt deletes it with force.
- `dsh_cleanup` only cleans a worktree; `dsh_delete` removes the job record.
- Active or queued jobs cannot be deleted.

The skill should pass the stable `group_id` and `group_name` on every
`dsh_start`, and should reuse every returned `job_id` for status, events, result,
cancel, cleanup, and delete calls instead of asking the user to type ids.

## Configuration

All policy is server-side. Tool arguments cannot choose the binary, environment,
DSH home, patches, or unrestricted permissions.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_WORKERS_DSH_BIN` | `dsh` | Absolute path recommended. |
| `DSH_WORKERS_ALLOWED_ROOTS` | MCP process cwd | Colon- or comma-separated directories. |
| `DSH_WORKERS_STATE_DIR` | `$XDG_STATE_HOME/dsh-workers` or `~/.local/state/dsh-workers` | Job metadata and logs; mode 0700. |
| `DSH_WORKERS_WORKTREE_ROOT` | `<state>/worktrees` | Git worktrees created by the server. |
| `DSH_WORKERS_DSH_HOME` | `<state>/dsh-home` | Shared DSH profile and session store. |
| `DSH_WORKERS_PROFILE` | `work-openrouter` (fallback `headless`) | Starting profile for new workers. |
| `DSH_WORKERS_MAX_CONCURRENT` | `3` | Hard maximum 8. |
| `DSH_WORKERS_MAX_QUEUE` | `16` | Bounded queue. |
| `DSH_WORKERS_DEFAULT_TIMEOUT_S` | `1200` | Default per-job wall clock. |
| `DSH_WORKERS_MAX_TIMEOUT_S` | `3600` | Tool argument ceiling. |
| `DSH_WORKERS_MAX_DEPTH` | `2` | Recursion guard through `DSH_WORKERS_DEPTH`. |
| `DSH_WORKERS_RETENTION_DAYS` | `7` | Delete terminal job records after this many days; `0` disables. |
| `DSH_WORKERS_SESSION_ID` | MCP instance id | Default parent-session id for new jobs. |
| `DSH_WORKERS_SESSION_NAME` | current directory name | Default parent-session display name. |
| `DSH_WORKERS_USE_DSH_CREDENTIALS` | off | Read `DEEPSEEK_API_KEY`, `OPENROUTER_CHAT_API_KEY` and `OPENCODE_GO_API_KEY` from the configured credential file. |
| `DSH_WORKERS_CREDENTIALS_FILE` | `~/.dsh/.credentials.yaml` | Used only when the credential opt-in is on. |
| `DSH_WORKERS_ENV_ALLOW` | empty | Extra environment variable names allowed into workers. |
| `DSH_WORKERS_UI_PORT` | `47100` | Default live dashboard port. |
| `DSH_WORKERS_STALL_S` | `120` | Warn when an active job has no event for this many seconds (30..3600). |
| `DSH_WORKERS_LOOP_REPEAT` | `4` | Warn when the same tool call repeats this many times in the last 10 calls (2..20). |
| `DSH_WORKERS_TOOL_ERROR_LIMIT` | `5` | Warn when this many of the last 10 tool results are not `completed` (1..50). |
| `DSH_WORKERS_MAX_STEPS` | unset | Warn (or cancel) when a job exceeds this many steps. Off by default. |
| `DSH_WORKERS_MAX_COST_USD` | unset | Warn (or cancel) when the estimated cost exceeds this USD amount. Off by default. |
| `DSH_WORKERS_WATCHDOG_ACTION` | `warn` | `warn` or `cancel`; `cancel` only applies to the budget watchdog. |

The server passes a small environment allowlist to workers and always forces
`DSH_PERMISSION_MODE=read-only` or `workspace-write`. It never exposes
`danger-full-access`.

If a configured state directory is on a read-only filesystem, the server logs
`state_dir_fallback` to stderr and uses `$TMPDIR/dsh-workers/{state,worktrees,dsh-home}`
instead. That keeps a user-scoped MCP usable on managed machines with a read-only
home, but the fallback state is temporary.

## MCP tools

- `dsh_start`: start a worker and return a job id immediately; accepts `group_id`, `group_name`, and an optional `profile`.
- `dsh_group`: read or set the parent-session group used by new jobs.
- `dsh_profile`: read or switch the DSH profile for this MCP session.
- `dsh_status`: inspect running and queued jobs, including token breakdown, estimated cost, and watchdog alerts.
- `dsh_wait`: wait for any or all jobs, with a bounded timeout; returns early with `alerted` when a watched job gains a new alert kind.
- `dsh_result`: read the final answer, stderr tail, worktree diff, usage and estimated cost.
- `dsh_events`: read a cursor-based page of live NDJSON events.
- `dsh_cancel`: cancel a queued or running job.
- `dsh_steer`: cancel a queued or running job (settled as `cancelled`/`steered`) and resume its DSH session with a self-contained corrective message; a terminal job is resumed without a cancel.
- `dsh_cleanup`: remove a finished worktree and branch.
- `dsh_delete`: delete a terminal job record, logs, and its clean worktree.

## Watchdogs

The server folds each worker's NDJSON events and recomputes alerts on every
event and about every five seconds, with no model calls:

- `stalled`: no event for `DSH_WORKERS_STALL_S` seconds;
- `loop`: the same tool with identical input at least `DSH_WORKERS_LOOP_REPEAT`
  times in the last 10 tool calls;
- `tool_errors`: at least `DSH_WORKERS_TOOL_ERROR_LIMIT` non-`completed` tool
  results in the last 10 results;
- `budget`: steps or estimated cost above the optional limits.

Alerts are stored in `job.json` and reported by `dsh_status`, `dsh_wait`,
`dsh_group`, and the dashboard. `DSH_WORKERS_WATCHDOG_ACTION=cancel` stops a
budget-exceeding job as `cancelled` with reason `budget_exceeded`; all other
alerts remain warnings. `dsh_wait` reports jobs that gained a new alert kind in
`alerted`, so the caller can inspect with `dsh_events` and decide whether to
`dsh_steer`.

## Pricing

Cost estimates use published list prices in USD per million tokens, captured on
2026-10-20 from OpenRouter's `/api/v1/models` and the installed pi-ai catalogs:

| Provider / model | Input | Output | Cache read |
| --- | ---: | ---: | ---: |
| `openrouter` / `~deepseek/deepseek-flash-latest` | $0.07 | $0.50 | $0.008 |
| `deepseek-official` / `deepseek-flash` | $0.30 | $1.20 | $0.006 |
| `opencode-go` / `deepseek-v4.1-flash` | $0.15 | $0.60 | $0.003 |
| `opencode-go` / `glm-5.3-flash` | $0.15 | $0.50 | $0.03 |

These are estimates: they exclude taxes, discounts, provider rounding and any
cache-write charge not listed by the provider. Update `src/pricing.ts` when a
provider changes prices.

## Security boundary

The DSH sandbox governs file writes; it does not hide the readable home
directory or close the network. Do not delegate secrets, production actions, or
untrusted instructions. Use read-only unless a worktree is required, and review
every diff. Worktree cleanup never discards changes unless `discard_changes` is
explicitly true.

## Limitations

- The server stores job state in memory and recovers only terminal metadata after
  restart; live jobs are marked `interrupted` and their known process group is
  killed when the pid identity still matches.
- A fresh worktree does not include ignored build artifacts such as
  `node_modules`.
- Only Linux `/proc` start-time matching is implemented; other POSIX platforms
  mark live restored jobs interrupted without the identity check.
- No automatic commits, merges, container creation, or remote workers.
- These are external DSH processes, not native Claude Tasks or DSH TUI
  subagents. They do not appear in either harness's native subagent panel.
- The dashboard is a monitor, not the DSH TUI or a live attach into a worker
  process. Use `dsh_events` or the dashboard for visibility.
