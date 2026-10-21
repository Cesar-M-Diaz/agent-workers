# agent-workers

A Claude Code plugin and its own marketplace for running DeepSeek Harness
(`dsh`) or pi headless workers in parallel. One install brings the MCP server,
the `parallel` skill, the `/agent-workers:*` slash commands, and a native pane.

This is an independent personal project. It is not an official DeepSeek package
and is not part of N|Solid or NodeSource.

The server uses one `dsh --profile <profile> --json` or `pi --mode json` process
per job. It provides a bounded FIFO queue, wall-clock timeouts, process-group
cancellation, optional git worktree isolation, session grouping, artifact-based
results, automatic retention for terminal jobs, pure heuristic watchdogs, and
session steering through `worker_steer`.

```text
Claude Code plugin "agent-workers"
  ├── MCP server "agent-workers" (plugin-dist/server.mjs)
  │     └── one dsh or pi process per job
  │           └── provider/model from the backend profile
  ├── skill: parallel
  ├── commands: /agent-workers:start, ...
  └── pane: live job cards beside the conversation
```

These workers are separate dsh or pi processes. They are not Claude `Task` calls
and do not appear in the DSH TUI native subagent side panel.

## Backends

`backend` selects the worker engine:

- `dsh` (default): one `dsh --profile <profile> --json` process per job. The
  profile comes from `$AGENT_WORKERS_DSH_HOME/profiles`; read-only and
  workspace-write are enforced with `DSH_PERMISSION_MODE`.
- `pi`: one `pi --mode json` process per job, task on stdin, one session per job.
  `profile` is `default`, a model pattern such as
  `openrouter/deepseek/deepseek-v4.1-flash-1017:low`, or a named profile from
  `pi_profiles_file`. pi workers are read-only by default: `pi_allow_write`
  (or `AGENT_WORKERS_PI_ALLOW_WRITE=1`) enables workspace-write, which should
  only be used with worktree isolation. pi has no sandbox; read the security
  section before enabling writes. pi resume and steer reuse the original job's
  session directory.

pi workers inherit the user's pi auth through `~/.pi/agent/auth.json`, or use
`pi_agent_dir` to point at a dedicated `PI_CODING_AGENT_DIR`. Provider API keys
are not passed through the worker environment allowlist.

## How it works

A typical delegation, end to end:

1. You ask Claude for work that splits into independent pieces. The
   `parallel` skill tells Claude when to delegate and how to write a
   self-contained task, because a worker never sees your conversation.
2. Claude calls `worker_start`. Code changes run as `workspace-write` in a fresh
   git worktree (`<state>/worktrees/<job>`, branch `dsh/<job>`); read-only work
   runs in place. The server queues the job and spawns
   `dsh --profile <profile> --json` or `pi --mode json`, feeding the task on
   stdin.
3. The worker's NDJSON events are appended to `<state>/jobs/<job>/events.ndjson`
   and folded into `job.json`. The pane and the dashboard read those files
   directly, so you watch progress without any model calls.
4. Claude waits with `worker_wait`. Watchdogs flag stalls, loops, repeated tool
   errors and budget overruns; a new alert wakes the wait (`alerted`) so Claude
   can inspect `worker_events` and correct the worker with `worker_steer`, which
   cancels it and resumes the same session with a new instruction.
5. Claude reads `worker_result` (final answer plus the worktree diff), verifies it
   against the project's checks, and applies or rejects it.
6. Claude deletes or cleans the job in the same turn (`worker_delete` /
   `worker_cleanup`). You can do the same from the pane's buttons.

A worker cannot receive messages while it runs: dsh headless and `pi --mode json`
answer one task and exit. Steering is always cancel + resume.

## Install

The repository is both the plugin and its marketplace:

```text
/plugin install agent-workers --marketplace Cesar-M-Diaz/agent-workers
```

Or register the marketplace first and install by name:

```text
/plugin marketplace add Cesar-M-Diaz/agent-workers
/plugin install agent-workers@agent-workers
```

To install from a local clone (no push needed), register the folder as the
marketplace:

```sh
claude plugin marketplace add /path/to/agent-workers
claude plugin install agent-workers@agent-workers
# after editing the clone: bump the version in .claude-plugin/plugin.json, then
claude plugin marketplace update agent-workers
claude plugin update agent-workers@agent-workers
```

To run a working copy for one session without installing:

```sh
claude --plugin-dir /path/to/agent-workers
```

Then set the plugin's `userConfig` values. The interactive `/plugin` installer
asks for them; a CLI install leaves them unset. Either way you can set them
later with `/plugin configure agent-workers@agent-workers`, or from a shell:

```sh
echo '{"allowed_roots":"/home/me/work:/home/me/projects","dsh_bin":"/home/me/.volta/bin/dsh","use_dsh_credentials":"true"}' \
  | claude plugin configure agent-workers@agent-workers --values-stdin
```

Values are stored in `pluginConfigs` in your settings and passed to the MCP
server through `.mcp.json` env substitution. Restart Claude Code after changing
them.

Set `allowed_roots` explicitly. Left empty, workers may only use the directory
Claude Code was started in.

When you open Claude Code inside this repository, it also offers the root
`.mcp.json` as a project MCP server. Decline it: the installed plugin already
provides the same server, and enabling both duplicates every tool.

### Plugin settings

| `userConfig` key | MCP environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `allowed_roots` | `AGENT_WORKERS_ALLOWED_ROOTS` | empty → MCP process cwd | Colon- or comma-separated directories workers may use. |
| `backend` | `AGENT_WORKERS_BACKEND` | `dsh` | `dsh` or `pi`. |
| `dsh_bin` | `AGENT_WORKERS_DSH_BIN` | empty → `dsh` on `PATH` | Absolute path to the `dsh` executable. |
| `pi_bin` | `AGENT_WORKERS_PI_BIN` | empty → `pi` on `PATH` | Absolute path to the `pi` executable. |
| `state_dir` | `AGENT_WORKERS_STATE_DIR` | an existing `~/.local/state/dsh-workers`, else `$XDG_STATE_HOME/agent-workers` or `~/.local/state/agent-workers` | Job metadata, logs, worktrees, and the shared DSH home. |
| `use_dsh_credentials` | `AGENT_WORKERS_USE_DSH_CREDENTIALS` | `false` | Read provider keys from `~/.dsh/.credentials.yaml` when they are not in the worker environment (dsh backend). |
| `max_concurrent` | `AGENT_WORKERS_MAX_CONCURRENT` | `3` | Hard maximum 8. |
| `profile` | `AGENT_WORKERS_PROFILE` | `work-openrouter` (dsh) or `default` (pi) | dsh profile name, pi model pattern, or named pi profile. |
| `pi_model` | `AGENT_WORKERS_PI_MODEL` | empty → pi's configured model | Model for the `default` pi profile. |
| `pi_thinking` | `AGENT_WORKERS_PI_THINKING` | empty → pi's configured level | off, minimal, low, medium, high, xhigh or max. |
| `pi_agent_dir` | `AGENT_WORKERS_PI_AGENT_DIR` | empty → user's pi config | Dedicated `PI_CODING_AGENT_DIR` for workers. |
| `pi_profiles_file` | `AGENT_WORKERS_PI_PROFILES_FILE` | `<state_dir>/pi-profiles.json` | Named pi profiles. |
| `pi_allow_write` | `AGENT_WORKERS_PI_ALLOW_WRITE` | `false` | Allow `workspace-write` for pi; use only with worktree isolation. |
| `pane_background` | — (pane only) | empty → Claude Code's pane fill | `#rrggbb` background for the pane, e.g. your terminal's, so it matches the chat. |

The substitution uses the documented `${user_config.KEY}` form inside the MCP
server's `env`. Empty values are safe: the server treats them as unset and uses
its built-in defaults. The pane reads the same `state_dir` — it uses the plugin's
`userConfig` value first, then `$AGENT_WORKERS_STATE_DIR` (or legacy
`$DSH_WORKERS_STATE_DIR`), then an existing `~/.local/state/dsh-workers`, then
`$XDG_STATE_HOME/agent-workers` or `$HOME/.local/state/agent-workers`.

### Migrating from dsh-workers 0.3.x

The plugin was renamed because dsh is now one of two backends. The short version
is in [`docs/MIGRATION.md`](docs/MIGRATION.md); the old standalone setup also
needs these removals:

```sh
claude mcp remove dsh-workers -s user
rm -rf ~/.claude/skills/dsh-parallel
rm -f ~/.claude/commands/dsh-*.md
```

Remove any old `dsh-workers` entry from a project `.mcp.json` or
`~/.claude.json` that points at the old `dist/server.js`. Install the new plugin
and let it provide `plugin-dist/server.mjs`. Job state under
`~/.local/state/dsh-workers` is compatible and is reused; the new default
prefers it when it already exists.

## Requirements

- Node 24+
- pnpm 10+ for development
- `dsh` and a DeepSeek, OpenRouter or OpenCode Go credential for the dsh
  backend
- `pi` and its auth for the pi backend (optional)
- Writable state and DSH home directories

## Build, bundle, and test

```sh
pnpm install --frozen-lockfile
pnpm build          # tsc + dist assets for local development
pnpm bundle         # self-contained plugin-dist/ server and dashboard
pnpm test
pnpm lint
pnpm bundle:check   # fails if plugin-dist/ is stale
claude plugin validate .
claude plugin test .
```

`plugin-dist/` is committed. It contains self-contained ESM bundles with their
dependencies inlined:

```text
plugin-dist/server.mjs      MCP server (stdio)
plugin-dist/ui.mjs          live dashboard CLI
plugin-dist/dashboard.html  dashboard asset copied beside ui.mjs
```

Run `pnpm bundle` after changing anything under `src/` that must ship in the
plugin, then commit `plugin-dist/`. The bundle is deterministic; `pnpm bundle`
must produce byte-identical output for the same sources. `pnpm test` includes a
freshness check and a stdio smoke test that answers `initialize` and
`tools/list` with `worker_steer` and the other ten tools.

## Live dashboard

The standalone dashboard reads the shared worker state directory and streams
job updates over Server-Sent Events. It is read-only except for terminal-job
deletion and binds to loopback only.

From the plugin:

```sh
node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs"
```

From a development checkout:

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
node plugin-dist/ui.mjs --detach --open
```

Control the background dashboard:

```sh
node plugin-dist/ui.mjs --status
node plugin-dist/ui.mjs --stop
```

Focus one job:

```sh
node plugin-dist/ui.mjs --detach --open --job j_abc123
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

## Claude Code pane

The plugin includes a native pane that shows DSH worker jobs live beside the
conversation. It reads the same state directory the MCP writes, so jobs started
by any session show up without an MCP round trip.

### What it shows

- **Header:** `Agent Workers` in the accent color with a `this project` / `all`
  toggle on the right. Below it, a status summary of the visible rows, for
  example `◌ 2 running · ○ 1 queued · ✓ 5 · ✗ 1`; zero segments are omitted and
  an empty list reads `idle`. A dim third line totals the visible rows' cost
  and tokens and names the newest job's profile/model, for example
  `$0.42 · 1.2M tok · personal-deepseek · deepseek-flash`.
- **Job cards:** one round-bordered card per job, sorted active first and then
  newest `createdAt`. At most 30 terminal jobs are shown; active jobs are never
  cut. The border and badge follow the status; terminal cards other than
  failures are drawn with a dim border so running and failed work stands out.
- **Collapsed:** `▶/▼ label` on the left and a status badge on the right, then
  `model · 3m12s · $0.09 · 12 steps · 18 tools` (missing pieces omitted). A
  running card adds its latest activity and freshness, for example
  `◌ bash · pnpm test · 3s ago`; after 90 seconds without an event it shows
  `⚠ no events for 2m` in the warning color. Current MCP watchdog alerts are
  shown as a warning line, for example
  `⚠ loop · same bash call repeated 5× in last 10`; an active card with alerts
  also gets a warning-colored border.
- **Expanded:**
  - `─ activity`: the last 8 tool calls with `✓` completed, `✗` failed and `◌`
    waiting glyphs, the tool in bold and its summary dim.
  - `─ tools`: the top 5 tools by call count, for example
    `bash 54 · read 20 · edit 8 · grep 6`.
  - `─ says` (running only): the last assistant `text` event, up to 3 lines.
  - `─ details`: profile/provider, access and isolation, branch and base
    commit, group, start time and duration, turn-end kind, and malformed-line
    count when present.
  - `─ tokens`: input/output/cache counts and cache-hit percentage, reasoning
    tokens, and cost.
  - `─ result`: `final.md` rendered as Markdown for a succeeded job, with a
    `more` / `less` toggle (14 lines preview, 200-line cap); a nested
    error-colored block with reason, error message and the last 3 stderr lines
    for a failed, timed-out or interrupted job.
  - Actions to `copy id`, `copy branch`, and — for terminal jobs only —
    `cleanup` (when the worktree exists and is not cleaned) and `delete`.
    Every destructive action needs a second press within five seconds:
    `confirm delete?` / `confirm cleanup?` turns warning-colored. If the tool
    reports a dirty or preserved worktree, the card shows
    `worktree has changes` and offers `discard & delete` / `discard & clean`,
    each with its own confirming second press. The card shows the short result
    (`deleted`, `cleaned`, or the error) and the row disappears after a
    successful delete on the next refresh. Active jobs never show these
    buttons.
- **Footer:** `Updated HH:MM:SS` from the last successful refresh, and a
  warning-colored line when a read failed or a `job.json` read was truncated.
- By default only jobs belonging to this session's project are listed. A
  worktree job is matched through `worktree.repoRoot`; any other job through
  its `cwd`. Both must equal the session cwd or lie inside it. The toggle
  switches to all jobs and groups them under `groupName`.

Claude Code paints panes opaque with its own fill, which can differ from the
transcript, where the terminal's background shows. The pane keeps that default
fill; to match your terminal instead, set `pane_background` to its background
color (for example `#181818`). A pane cannot show a translucent or image
terminal background.

The pane asks for 58 columns and refreshes once a second from a timer. The
render hook reads only in-memory `$.state` atoms and never touches the file
system. Every line is measured against the card's inner width (`bodyColumns`
minus border and padding) and truncated with `…` rather than wrapped.

### Pane state directory

The first match wins:

1. The `state_dir` value in the plugin's `userConfig`.
2. `$AGENT_WORKERS_STATE_DIR`
3. `$XDG_STATE_HOME/agent-workers`
4. `$HOME/.local/state/agent-workers`

Under that directory the pane reads:

```text
<stateDir>/jobs/<job_id>/job.json
<stateDir>/jobs/<job_id>/events.ndjson
<stateDir>/jobs/<job_id>/final.md
<stateDir>/jobs/<job_id>/stderr.log
```

Only directory names matching `/^[A-Za-z0-9_-]+$/` are considered.

### How the data maps to the UI

`job.json` is camelCase and every field may be missing. The pane validates
types defensively and keeps the last valid value when a read is truncated. Its
`status` maps as follows:

| `status` | Row |
| --- | --- |
| `queued` | `○ QUEUED` |
| `starting`, `running` | `◌ RUNNING` |
| `succeeded` | `✓ SUCCEEDED` |
| `failed` | `✗ FAILED` |
| `timed_out` | `✗ TIMED_OUT` |
| `cancelled` | `− CANCELLED` |
| `interrupted` | `⚠ INTERRUPTED` |
| anything else | `? <raw status>` (sanitized) |

`events.ndjson` is one JSON object per line. The pane ignores malformed lines
and a partial last line while the MCP is appending. A single pass over the
events derives four things: the last 8 `tool_call` events (each paired with a
`tool_result` of the same `callId`), the top 5 tool call counts, the last
assistant `text` event, and the last `error` message. Events are read for every
active job and for an expanded job of any status; terminal events are read once,
and their unchanged mtime skips them on later refreshes.

The collapsed meta line comes from `job.json`: `model`, elapsed time from
`startedAt` (or `createdAt`) to `finishedAt` (or now), `costUsd`, `steps` and
`toolCalls`. Duration, token, cost, cache-hit and "ago" formatting all live in
`hooks/jobs.ts` so they can be unit-tested.

The expanded `details` section maps `profile`/`provider`, `access`
(`read-only` in the success color, `workspace-write` shown as `write` in the
warning color), `isolation` (`worktree` or `in-place`), `worktree.branch` and
the first 7 characters of `worktree.baseCommit` (with `(cleaned)` when
`worktree.cleaned` is true), `groupName`, `startedAt`/duration, `turnEndKind`,
and `malformedLines`. `alerts` from `job.json` are normalized to their `kind`,
`message` and optional `since`, and malformed entries are dropped before they
reach the renderer. The `tokens` section uses `usage.inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` and
`costUsd`; the cache-hit percentage is `cacheReadTokens / (inputTokens +
cacheReadTokens)`.

For a succeeded job, `final.md` is kept to its first 200 non-empty lines. The
`result` section shows the first 14 non-empty lines through the Markdown
element; `more` swaps in the full kept text and `less` returns to the preview.
For a failed, timed-out or interrupted job, the nested result block shows
`reason`, up to 4 lines of `errorMessage`, and the last 3 lines of
`stderrTail`. The `copy id` and `copy branch` buttons pass the press surface to
`$.ui.copy`.

**DSH "steps" are model-loop iterations, not named planned steps.** There is
no known total, so the pane deliberately shows a count (`N steps`) and never a
progress bar or `x/y`.

### Terminal placement

A pane opened by the plugin at session start is unasked, so it waits undrawn
below **144 terminal columns**. Once the person has opened `agent-workers`
manually, the floor is **110 columns**. On a fullscreen terminal from **110
columns** the pane docks beside the chat; otherwise it draws inline above the
prompt. `/agent-workers:pane` is the person's own request, so it is placed at
any width.

### `job.json` writes are atomic

The MCP rewrites `job.json` about once a second while a job runs. `writeJob`
writes a temporary file in the same directory and `rename()`s it over
`job.json`, so the pane, the dashboard, and a restarted server never read a
half-written file. The pane still keeps the last valid parsed job if a read
fails for another reason (a permissions error, a file from an older server).

## Headless credentials

The dsh worker profiles disable the DSH managed credential store. A worker can
receive `DEEPSEEK_API_KEY`, `OPENROUTER_CHAT_API_KEY` or `OPENCODE_GO_API_KEY`
explicitly, or read the references from the DSH credential store when
`AGENT_WORKERS_USE_DSH_CREDENTIALS=1`. The worker profile decides which provider
and model the worker uses.

Precedence is deliberate: a provider variable that is explicitly present in the
MCP server's environment wins over the same reference in the credentials file.
The plugin's `use_dsh_credentials` setting only fills keys that are otherwise
absent. pi does not use the dsh credential store: it reads its own
`~/.pi/agent/auth.json` (or the `PI_CODING_AGENT_DIR` set with `pi_agent_dir`).
Provider API keys are not forwarded through `AGENT_WORKERS_ENV_ALLOW` by
default. The jobs test clears the provider variables for its isolated manager so
an exported developer key cannot change the expected value; it restores them
without printing them.

## Worker profiles

Profiles live under `$AGENT_WORKERS_DSH_HOME/profiles`. The server starts in
`AGENT_WORKERS_PROFILE` (default `work-openrouter`, falling back to `headless`),
and `worker_profile` switches the profile for the current MCP session. `worker_start`
also accepts `profile` for a single job; existing jobs keep their profile,
including when resumed.

For example, a setup with one work and two personal providers could use:

| Profile | Provider | Model | Credential |
| --- | --- | --- | --- |
| `work-openrouter` | `openrouter` | `~deepseek/deepseek-flash-latest` | `OPENROUTER_CHAT_API_KEY` |
| `personal-deepseek` | `deepseek-official` | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| `personal-opencode` | `opencode-go` | `deepseek-v4.1-flash` | `OPENCODE_GO_API_KEY` |

Profile names are free-form; only `work-openrouter` and `headless` have a
meaning to the server, as the default starting profile and its fallback (or set
`profile` in the plugin settings). Create a directory per profile with the same
files (including `metadata.json`); `worker_profile` lists them dynamically.

Each profile also has a `metadata.json` with its `provider` and `model`. The
server copies that metadata into every job so the dashboard can estimate cost;
keep it in sync with `cordis.patch.yml` when changing the model.

### pi profiles

pi has no profile directories. A pi profile is one of:

- `default`: use pi's configured model, optionally overridden by `pi_model`
  and `pi_thinking`;
- a model pattern: `provider/model` with an optional `:<thinking>` suffix, for
  example `openrouter/deepseek/deepseek-v4.1-flash-1017:low`;
- a named entry in `pi_profiles_file` (`<state_dir>/pi-profiles.json`):

```json
{
  "deep-flash": {
    "provider": "openrouter",
    "model": "deepseek/deepseek-v4.1-flash-1017",
    "thinking": "low"
  }
}
```

The server resolves pi profiles with the pi backend; a dsh profile name is not
valid for pi (and vice versa). If the shared `profile` setting is a dsh name
while `backend=pi`, the server falls back to `default` and logs
`profile_fallback`.

## Claude skill

The plugin ships the skill at `skills/parallel/SKILL.md`; nothing needs to
be copied. It is available as `/agent-workers:parallel` and is loaded
automatically when a task matches its description.

The skill makes cleanup mandatory: after reviewing a result and applying,
merging, or rejecting its diff, it calls `worker_delete` (or `worker_cleanup` to keep
the record) in the same turn. Read-only jobs have no worktree, so their records
are deleted once the result is reported. Dirty worktrees whose changes were not
applied anywhere require the user's confirmation before `discard_changes: true`.

## Claude slash commands

The plugin ships these commands; the plugin prefix is part of the command name:

| Command | Purpose |
| --- | --- |
| `/agent-workers:start <task>` | Start one self-contained worker. |
| `/agent-workers:status [job ...]` | Show worker status and progress counters. |
| `/agent-workers:events <job> [cursor]` | Read a cursor-based page of live step events. |
| `/agent-workers:wait <job ...>` | Wait for jobs with a bounded timeout. |
| `/agent-workers:result <job>` | Read final answer, tails, and worktree changes. |
| `/agent-workers:cancel <job>` | Cancel a queued or running worker. |
| `/agent-workers:steer <job> <message>` | Cancel if active and resume the session with a corrective instruction. |
| `/agent-workers:cleanup <job>` | Clean up a terminal worktree. |
| `/agent-workers:delete <job>` | Delete a terminal job record and its files. |
| `/agent-workers:profile [profile]` | Read or switch the backend profile. |
| `/agent-workers:ui [start\|stop\|status\|restart]` | Control the live dashboard. |
| `/agent-workers:watch <job>` | Open the dashboard focused on one job. |
| `/agent-workers:pane` | Open the Agent Workers pane. |

Custom Claude commands are prompt templates: they instruct Claude to call the
MCP tools; they do not bypass the model or the MCP permission rules. The
commands reference the plugin's MCP tools by their namespaced tool names, for
example `mcp__plugin_agent-workers_agent-workers__worker_delete`. The dashboard
commands run `${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs`.

## Job lifecycle and cleanup

Cleanup is part of finishing a delegation, not an optional epilogue.

- After reviewing a job's result, once its diff has been applied to the user's
  tree, merged, or rejected, call `worker_delete` (or `worker_cleanup` to keep the
  record) in the same turn. Do not leave finished worktrees behind.
- `worker_delete` removes the terminal record, logs, and a clean worktree/branch.
  `worker_cleanup` removes the worktree and branch but keeps the record.
- If the worktree is dirty and its changes were **not** applied anywhere, ask
  the user before retrying with `discard_changes: true`. Never discard unmerged
  work silently.
- A read-only job has no worktree. Delete its record once the result has been
  reported, unless the user wants history.
- The pane's expanded terminal cards have `cleanup` and `delete` buttons; each
  needs a second confirming press. A dirty worktree adds `discard & clean` /
  `discard & delete`. For manual use, run `/agent-workers:cleanup` or
  `/agent-workers:delete`.
- Terminal job records are retained for `AGENT_WORKERS_RETENTION_DAYS` days
  (default `7`). Automatic retention never deletes a job with a dirty worktree
  or commits that are not reachable from the base revision. Those records stay
  until review.
- Active or queued jobs cannot be deleted.

The skill should pass the stable `group_id` and `group_name` on every
`worker_start`, and should reuse every returned `job_id` for status, events, result,
cancel, cleanup, and delete calls instead of asking the user to type ids.

## Configuration

All policy is server-side. Tool arguments cannot choose the binary, environment,
DSH home, patches, or unrestricted permissions.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_WORKERS_BACKEND` | `dsh` | `dsh` or `pi`. |
| `AGENT_WORKERS_DSH_BIN` | `dsh` | Absolute path recommended. |
| `AGENT_WORKERS_PI_BIN` | `pi` | Absolute path recommended. |
| `AGENT_WORKERS_ALLOWED_ROOTS` | MCP process cwd | Colon- or comma-separated directories. |
| `AGENT_WORKERS_STATE_DIR` | an existing `~/.local/state/dsh-workers`, else `$XDG_STATE_HOME/agent-workers` or `~/.local/state/agent-workers` | Job metadata and logs; mode 0700. Legacy `DSH_WORKERS_STATE_DIR` accepted. |
| `AGENT_WORKERS_WORKTREE_ROOT` | `<state>/worktrees` | Git worktrees created by the server. |
| `AGENT_WORKERS_DSH_HOME` | `<state>/dsh-home` | Shared DSH profile and session store. |
| `AGENT_WORKERS_PROFILE` | `work-openrouter` (dsh) or `default` (pi) | dsh profile, pi model pattern, or named pi profile. |
| `AGENT_WORKERS_PI_MODEL` | unset | Model for the pi `default` profile. |
| `AGENT_WORKERS_PI_THINKING` | unset | Thinking level for the pi `default` profile. |
| `AGENT_WORKERS_PI_AGENT_DIR` | unset | `PI_CODING_AGENT_DIR` for pi workers. |
| `AGENT_WORKERS_PI_PROFILES_FILE` | `<state>/pi-profiles.json` | Named pi profiles. |
| `AGENT_WORKERS_PI_ALLOW_WRITE` | off | Allow pi `workspace-write`; use only with worktree isolation. |
| `AGENT_WORKERS_MAX_CONCURRENT` | `3` | Hard maximum 8. |
| `AGENT_WORKERS_MAX_QUEUE` | `16` | Bounded queue. |
| `AGENT_WORKERS_DEFAULT_TIMEOUT_S` | `1200` | Default per-job wall clock. |
| `AGENT_WORKERS_MAX_TIMEOUT_S` | `3600` | Tool argument ceiling. |
| `AGENT_WORKERS_MAX_DEPTH` | `2` | Recursion guard through `AGENT_WORKERS_DEPTH`. |
| `AGENT_WORKERS_RETENTION_DAYS` | `7` | Delete terminal job records after this many days; `0` disables. |
| `AGENT_WORKERS_SESSION_ID` | MCP instance id | Default parent-session id for new jobs. |
| `AGENT_WORKERS_SESSION_NAME` | current directory name | Default parent-session display name. |
| `AGENT_WORKERS_USE_DSH_CREDENTIALS` | off | Read `DEEPSEEK_API_KEY`, `OPENROUTER_CHAT_API_KEY` and `OPENCODE_GO_API_KEY` from the configured credential file. |
| `AGENT_WORKERS_CREDENTIALS_FILE` | `~/.dsh/.credentials.yaml` | Used only when the credential opt-in is on. |
| `AGENT_WORKERS_ENV_ALLOW` | empty | Extra environment variable names allowed into workers. |
| `AGENT_WORKERS_UI_PORT` | `47100` | Default live dashboard port. |
| `AGENT_WORKERS_STALL_S` | `120` | Warn when an active job has no event for this many seconds (30..3600). |
| `AGENT_WORKERS_LOOP_REPEAT` | `4` | Warn when the same tool call repeats this many times in the last 10 calls (2..20). |
| `AGENT_WORKERS_TOOL_ERROR_LIMIT` | `5` | Warn when this many of the last 10 tool results are not `completed` (1..50). |
| `AGENT_WORKERS_MAX_STEPS` | unset | Warn (or cancel) when a job exceeds this many steps. Off by default. |
| `AGENT_WORKERS_MAX_COST_USD` | unset | Warn (or cancel) when the estimated cost exceeds this USD amount. Off by default. |
| `AGENT_WORKERS_WATCHDOG_ACTION` | `warn` | `warn` or `cancel`; `cancel` only applies to the budget watchdog. |

The server passes a small environment allowlist to workers and always forces
`DSH_PERMISSION_MODE=read-only` or `workspace-write`. It never exposes
`danger-full-access`.

If a configured state directory is on a read-only filesystem, the server logs
`state_dir_fallback` to stderr and uses `$TMPDIR/agent-workers/{state,worktrees,dsh-home}`
instead. That keeps a user-scoped MCP usable on managed machines with a read-only
home, but the fallback state is temporary.

## MCP tools

- `worker_start`: start a worker and return a job id immediately; accepts `group_id`, `group_name`, and an optional `profile`.
- `worker_group`: read or set the parent-session group used by new jobs.
- `worker_profile`: read or switch the active backend profile for this MCP session.
- `worker_status`: inspect running and queued jobs, including token breakdown, estimated cost, and watchdog alerts.
- `worker_wait`: wait for any or all jobs, with a bounded timeout; returns early with `alerted` when a watched job gains a new alert kind.
- `worker_result`: read the final answer, stderr tail, worktree diff, usage and estimated cost.
- `worker_events`: read a cursor-based page of live NDJSON events.
- `worker_cancel`: cancel a queued or running job.
- `worker_steer`: cancel a queued or running job (settled as `cancelled`/`steered`) and resume its session with a self-contained corrective message; a terminal job is resumed without a cancel.
- `worker_cleanup`: remove a finished worktree and branch.
- `worker_delete`: delete a terminal job record, logs, and its clean worktree; refuses while another active job shares its session directory.

## Watchdogs

The server folds each worker's NDJSON events and recomputes alerts on every
event and about every five seconds, with no model calls:

- `stalled`: no event for `AGENT_WORKERS_STALL_S` seconds;
- `loop`: the same tool with identical input at least `AGENT_WORKERS_LOOP_REPEAT`
  times in the last 10 tool calls;
- `tool_errors`: at least `AGENT_WORKERS_TOOL_ERROR_LIMIT` non-`completed` tool
  results in the last 10 results;
- `budget`: steps or estimated cost above the optional limits.

Alerts are stored in `job.json` and reported by `worker_status`, `worker_wait`,
`worker_group`, and the dashboard. `AGENT_WORKERS_WATCHDOG_ACTION=cancel` stops a
budget-exceeding job as `cancelled` with reason `budget_exceeded`; all other
alerts remain warnings. `worker_wait` reports jobs that gained a new alert kind in
`alerted`, so the caller can inspect with `worker_events` and decide whether to
`worker_steer`.

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

The dsh sandbox governs file writes; it does not hide the readable home
directory or close the network. pi has no sandbox: its `read-only` mode is a
tool allowlist (`read,grep,find,ls` with no MCP or extensions), and
`workspace-write` is disabled unless `pi_allow_write` is set. Even then, use a
worktree and review every diff. Do not delegate secrets, production actions, or
untrusted instructions. Use read-only unless a worktree is required, and review
every diff. Worktree cleanup never discards changes unless `discard_changes` is
explicitly true. The pane's destructive buttons never call a tool on the first
press and never show for active jobs.

## Development

```sh
pnpm bundle
pnpm test
pnpm lint
claude plugin validate .
claude plugin test .
```

The mod tests live in `tests/` and import from `claude-code/testing`; the
server, dashboard, and library tests live in `test/` as `*.spec.ts` so the mod
runner, which executes every `*.test.ts` / `*.test.tsx` under the plugin root,
does not try to load Node-only tests. The tests cover the pure functions in
`hooks/jobs.ts`, the engine integration with mocked `fs`, `env`, `session.cwd`,
clock, and MCP hooks, and the committed bundle's stdio surface.

A plugin loaded from disk (`claude --plugin-dir .`) is hot-reloaded when its
hooks module changes. Run `claude --debug` if a hook does not fire; a failed
hooks module is reported there with its reason.

## Limitations

- The server stores job state in memory and recovers only terminal metadata after
  restart; live jobs are marked `interrupted` and their known process group is
  killed when the pid identity still matches.
- A fresh worktree does not include ignored build artifacts such as
  `node_modules`.
- Only Linux `/proc` start-time matching is implemented; other POSIX platforms
  mark live restored jobs interrupted without the identity check.
- No automatic commits, merges, container creation, or remote workers.
- These are external dsh or pi processes, not native Claude Tasks or DSH TUI
  subagents. They do not appear in either harness's native subagent panel.
- pi resume and steer use the original job's session directory; a pi job is read-only unless
  `pi_allow_write` is enabled. Deleting or pruning the root of a steer chain makes
  later resumes fail with `resume_unavailable`, so keep the chain until it is no
  longer needed.
- pi reports a calculated cost, not a billed cost; the dashboard labels it as an
  estimate.
- The dashboard is a monitor, not the DSH TUI or a live attach into a worker
  process. Use `worker_events` or the dashboard for visibility.

## License

[MIT](LICENSE) © 2026 Cesar-M-Diaz
