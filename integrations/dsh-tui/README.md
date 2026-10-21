# dsh-tui-agent-workers

A read-only [dsh-tui](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui)
side panel that lists and details the jobs written by
[agent-workers](../../README.md) to its worker state directory. It reads the
same files as the Claude Code worker pane and never starts an MCP server.

## What it shows

- A header with running / queued / done counts and the total of known costs.
- One row per job: status glyph and label, then `model · steps · cost · elapsed`,
  plus the first alert when there is one.
- Groups by `groupId`; groups with active jobs come first. Jobs without a group
  appear under **Legacy / ungrouped**.
- A selected-job detail view (press `Enter`) with status/reason, backend,
  profile, model, access/isolation, cwd, worktree/branch, owner, session,
  lineage (`resumeOf` / `steeredFrom`), timestamps and elapsed, usage and cost,
  alerts, the last 8 tool calls, the last text/error and a preview of
  `final.md` (plus `stderrTail` for terminal failures).
- A `read-only` banner: this version has no cancel, steer, cleanup or delete
  actions.

## Keys (while the panel is focused)

| Key | Action |
| --- | --- |
| `↑` / `k` | Select previous job |
| `↓` / `j` | Select next job |
| `Enter` | Toggle the detail view |
| `r` | Refresh now |
| `a` | Toggle all groups / current project |

`selectedId` and `showAll` are persisted through `host.storage`. The panel
badges new failed jobs with `host.notify('error', n)` and clears the badge when
it receives focus.

## Install (local `link:`)

From the profile that runs dsh-tui, link the package and add it to the bundle
list in `~/.dsh/profiles/dsh-tui/package.json`:

```json
{
  "dependencies": {
    "dsh-tui-agent-workers": "link:/path/to/agent-workers/integrations/dsh-tui"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-harness-tui/dsh-tui",
        "dsh-tui-stt",
        "dsh-tui-quotas",
        "dsh-tui-agent-workers"
      ]
    }
  }
}
```

Then install the profile and restart dsh-tui:

```sh
cd ~/.dsh/profiles/dsh-tui
pnpm install
# restart dsh-tui, then press Ctrl+B and pick "Agent Workers"
```

The panel is auto-enabled by the plugin registration; no manual
`sidePanel.panels` edit is required. `dsh-tui doctor` and `dsh-tui version`
should both report 0.16.x.

## Configuration

The plugin accepts one config key:

```yaml
- insert:
    - id: dsh-tui-agent-workers
      name: 'dsh-tui-agent-workers'
      config:
        stateDir: /home/me/.local/state/agent-workers
```

| Key | Meaning |
| --- | --- |
| `stateDir` | Explicit state directory. Overrides every environment source. Blank is ignored. |

Without `stateDir`, the directory is resolved exactly as in
`docs/control-protocol.md` §2:

1. `AGENT_WORKERS_STATE_DIR`
2. `DSH_WORKERS_STATE_DIR`
3. an existing `$XDG_STATE_HOME/dsh-workers` (or `~/.local/state/dsh-workers`)
4. otherwise `$XDG_STATE_HOME/agent-workers` (or
   `~/.local/state/agent-workers`)

Blank environment values count as unset. `stateDir` is the recommended way to
keep the panel and the Claude Code plugin pointed at the same directory.

## Read-only limitations

- No actions: no cancel, steer, cleanup, delete, attach or dashboard launch.
- The panel only reads `jobs/<id>/job.json`, `events.ndjson` and, for the
  selected terminal job, `final.md`. It never writes the state dir, never
  starts an agent-workers MCP server and makes no network calls.
- Worker output is untrusted data: ANSI/OSC escapes and C0/C1 control
  characters are stripped, whitespace collapsed and every line truncated to
  the available width before rendering.
- Events are read only for active jobs and the selected job (last 3.5 MB);
  `final.md` only for the selected terminal job (at most 1 MB). Reads are
  cached by `mtimeMs + size`.
- Polling is 1 s while the panel is visible or a job is active, 4 s when idle.
  No filesystem access happens during render.

## Compatibility

- **dsh-tui 0.16.x**, `ctx.tuiPanels` API v1 (`TUI_PANEL_API_VERSION = 1`).
  The panels seam is experimental; a future dsh-tui minor may change it.
- **agent-workers >= 0.4** (state dir layout and `job.json` fields used here).
- Node.js >= 24, as required by the dsh-tui profile.

## Development

```sh
cd integrations/dsh-tui
pnpm install --ignore-workspace
pnpm test        # tsc -p tsconfig.json && node --test lib/*.spec.js
pnpm build
```

Tests cover sanitization, state-dir resolution, the shared
`test/fixtures/state` README cases, torn `job.json` recovery, selected-only
`events.ndjson` / `final.md` reads, and view-model width limits at 28, 40 and
64 columns.
