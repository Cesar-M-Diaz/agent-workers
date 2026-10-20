# dsh-workers-pane

A native Claude Code mod that shows DeepSeek Harness (DSH) worker jobs live in
a side pane beside the conversation. It reads the same state directory the
`dsh-workers` MCP writes, so jobs started by any session show up here without
an MCP round trip.

## What it shows

- **Header:** `DSH Workers` in the accent color with a `this project` / `all`
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
  - Actions to `copy id` and, for worktrees, `copy branch`.
- **Footer:** `Updated HH:MM:SS` from the last successful refresh, and a
  warning-colored line when a read failed or a `job.json` read was truncated.
- By default only jobs belonging to this session's project are listed. A
  worktree job is matched through `worktree.repoRoot`; any other job through
  its `cwd`. Both must equal the session cwd or lie inside it. The toggle
  switches to all jobs and groups them under `groupName`.

The pane asks for 58 columns and refreshes once a second from a timer. The
render hook reads only in-memory `$.state` atoms and never touches the file
system. Every line is measured against the card's inner width (`bodyColumns`
minus border and padding) and truncated with `…` rather than wrapped.

## Install and run

From the repository root:

```sh
claude --plugin-dir <repo>/claude/mods/dsh-workers-pane
```

If the folder is published through a marketplace, the one-step install is:

```text
/plugin install dsh-workers-pane --marketplace <owner>/<repo>
```

The mod registers the immediate slash command:

```text
/dsh-pane
```

`/dsh-pane` opens the pane on demand. The mod also opens it at session start
without taking focus.

## State directory

The first match wins:

1. The `stateDir` option in the plugin's `userConfig` (for a `--plugin-dir`
   plugin, set it under `pluginConfigs["dsh-workers-pane"].options.stateDir`
   in settings).
2. `$DSH_WORKERS_STATE_DIR`
3. `$XDG_STATE_HOME/dsh-workers`
4. `$HOME/.local/state/dsh-workers`

Under that directory the pane reads:

```text
<stateDir>/jobs/<job_id>/job.json
<stateDir>/jobs/<job_id>/events.ndjson
<stateDir>/jobs/<job_id>/final.md
<stateDir>/jobs/<job_id>/stderr.log
```

Only directory names matching `/^[A-Za-z0-9_-]+$/` are considered.

## How the data maps to the UI

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

## Terminal placement

A pane opened by the mod at session start is unasked, so it waits undrawn
below **144 terminal columns**. Once the person has opened `dsh-workers`
manually, the floor is **110 columns**. On a fullscreen terminal from **110
columns** the pane docks beside the chat; otherwise it draws inline above the
prompt. `/dsh-pane` is the person's own request, so it is placed at any width.

## A note for the MCP: write `job.json` atomically

The MCP rewrites `job.json` in place, non-atomically, about once a second.
A reader can therefore see a truncated or invalid file. This mod is tolerant:
it keeps the last valid parsed job and shows a small dim warning instead of
dropping the row, and it recovers on the next valid read.

The cleaner fix belongs in the MCP's `writeJob`: write to a temporary file in
the same directory and `rename()` it over `job.json`. Rename is atomic on the
same filesystem, so readers never observe a half-written file.

## Development

```sh
claude plugin validate claude/mods/dsh-workers-pane
cd claude/mods/dsh-workers-pane && claude plugin test
```

The tests cover the pure functions in `hooks/jobs.ts` and the engine
integration with mocked `fs`, `env`, `session.cwd` and clock hooks.
