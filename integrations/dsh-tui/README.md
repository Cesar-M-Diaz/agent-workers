# dsh-tui-agent-workers

A [dsh-tui](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui) side
panel that lists and details the jobs written by
[agent-workers](../../README.md) to its worker state directory. It reads the
filesystem read model and talks to each live MCP owner's loopback control API
(`docs/control-protocol.md`) for cancel, steer, cleanup and delete. It never
starts an MCP server and never writes the state dir.

## What it shows

- A header with running / queued / done counts, the total of known costs and
  the control status: `control: N owners` or, with no live owner,
  `control offline — read-only`.
- One row per job: status glyph and label, then `model · steps · cost · elapsed`,
  plus the first alert when there is one.
- Groups by `groupId`; groups with active jobs come first. Jobs without a group
  appear under **Legacy / ungrouped**.
- A selected-job detail view (press `Enter`) with status/reason, backend,
  profile, model, access/isolation, cwd, worktree/branch, owner, session,
  lineage (`resumeOf` / `steeredFrom`), timestamps and elapsed, usage and cost,
  alerts, the last 8 tool calls, the last text/error, a preview of `final.md`
  (plus `stderrTail` for terminal failures), and the actions the owner offers.
- A footer with the armed confirmation or the last action result.

## Keys (while the panel is focused)

| Key | Action |
| --- | --- |
| `↑` / `k` | Select previous job |
| `↓` / `j` | Select next job |
| `Enter` | Toggle the detail view |
| `r` | Refresh now |
| `a` | Toggle all groups / current project |
| `c` | Cancel the selected job |
| `s` | Steer the selected job (full-screen editor) |
| `x` | Clean up the selected terminal job's worktree |
| `d` | Delete the selected terminal job |

`selectedId` and `showAll` are persisted through `host.storage`. The panel
badges new failed jobs with `host.notify('error', n)` and clears the badge when
it receives focus.

## Actions and confirmations

Actions are routed to the owner whose `owner_id` equals the selected job's
`ownerId` in the read model. The panel mirrors the server's `capabilities`:
keys whose capability is `false`, and all action keys while there is no live
owner, are disabled and the footer explains why (`cancel unavailable: control
offline`, `cleanup unavailable: not available for this job`, …).

- `c`, `x` and `d` need **two presses within 5 s**: the first arms
  `confirm <action>?` in the footer, the second calls the owner. Any other key
  or the five-second timeout disarms.
- `cleanup`/`delete` can report a dirty worktree. A cleanup returns
  `worktree: preserved_dirty`; a delete returns HTTP 409 `worktree_dirty`. In
  both cases the footer offers `discard & <action>?`. That second confirmation
  also needs two presses: the first arms `confirm discard?`, the second calls
  the same route with `discard_changes: true` (POST body for cleanup,
  `?discard_changes=1` for DELETE).
- One action is in flight per job; further presses are ignored until it
  finishes. Errors are sanitized and shown for that job in the detail view
  (`action error …`) and as the footer result.
- After a successful action the panel refreshes the state dir and re-discovers
  owners immediately.

## Steer

`s` opens the full-screen **Steer worker** scene for the selected job. It is
offered only when the server reports `capabilities.steer: true` and the job's
owner is live; otherwise the footer explains why (`steer unavailable: control
offline`, `steer unavailable: not available for this job`, …). The target job
id is handed to the scene through the store, because the scene is registered
once at activation.

**Steer is cancel + resume, not a live interruption.** For an active job the
server cancels the original first. If the resume then fails, the original stays
cancelled; this is why the scene shows the warning before submitting:

```text
warning: steer cancels this running job first;
if resuming fails it stays cancelled
```

Inside the scene:

| Key | Action |
| --- | --- |
| Printable text | Insert at the cursor (paste supported) |
| `Enter` | New line |
| `Backspace` / `Delete` | Delete before / after the cursor |
| `←` `→` `↑` `↓`, `Home`, `End` | Move the cursor |
| `Ctrl+S` | Submit; a second `Ctrl+S` within 5 s confirms |
| `Esc` | Close without sending (also clears any armed confirmation) |

The editor is a multiline buffer with a hard **20 000 character** limit,
matching the control API (`message: 1..20000`). Input beyond the limit is
refused, never truncated. The status line always shows `n/20000`, the
confirmation hint, `sending…`, or the sanitized error code/message. While the
request is in flight all input is ignored. On success the scene shows the new
`steered_job_id` and returns to the panel; on error the text is kept so the user
can fix it and retry, or press `Esc`. The panel refreshes after a 2xx like the
other actions, and a failure adds `action error <code>: <message>` to the job's
detail.

### Fallback when scenes are unavailable

The scene needs `ctx.tuiScenes`. If that seam is missing at activation time,
`s` falls back to `ctx.tuiDialogs.input` (plus a confirmation dialog with the
same cancel-first warning). The input dialog is limited to **500 cells**; the
fallback warns about that limit and refuses longer text instead of silently
truncating it. If neither `tuiScenes` nor `tuiDialogs` is available, steer is
disabled and the footer says so. The panel never falls back to a truncated
steer message.

## Discovery and read-only fallback

Every five seconds the store reads `<state>/control/*.json` and validates each
descriptor exactly like contract §6:

- file name `^[A-Za-z0-9_-]+\.json$`, a regular file (symlinks are ignored);
- no group/other permission bits (`mode & 0o077 === 0`);
- `owner_id` equals the file name, `protocol` is
  `agent-workers-control/1`, `ready` is `true` and `control` is non-null;
- the pid is alive (`process.kill(pid, 0)`; `EPERM` counts as alive).

Each live owner gets an 800 ms health probe (`GET /v1/health`, Bearer token)
and, when healthy, `GET /v1/jobs`. Failures back off per owner for 1/2/5/10 s.
The panel then keeps a `jobId → { ownerId, capabilities }` map.

With no live or healthy owner the header shows
`control offline — read-only`; the job list and detail view keep working from
the filesystem. No network call is made for a job whose owner is not live.

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

## Security and limitations

- Network access is limited to `127.0.0.1` control servers discovered from the
  state dir. Every request sends `Authorization: Bearer <token>` from the
  descriptor; the token is never rendered, logged or included in errors.
- The panel never writes the state dir, never kills processes and never starts
  an MCP server. Mutations only happen through the owning server's HTTP API.
- Worker output is untrusted data: ANSI/OSC escapes and C0/C1 control
  characters are stripped, whitespace collapsed and every line truncated to
  the available width before rendering.
- Events are read only for active jobs and the selected job (last 3.5 MB);
  `final.md` only for the selected terminal job (at most 1 MB). Reads are
  cached by `mtimeMs + size`.
- Filesystem polling is 1 s while the panel is visible or a job is active, 4 s
  when idle. Descriptor discovery is every 5 s. No filesystem or network access
  happens during render.

## Compatibility

- **dsh-tui 0.16.x**, `ctx.tuiPanels` API v1 (`TUI_PANEL_API_VERSION = 1`) and
  `ctx.tuiScenes`/`ctx.tuiDialogs` for steer. The panels and scenes seams are
  experimental; a future dsh-tui minor may change them.
- **agent-workers >= 0.5** with the control protocol
  `agent-workers-control/1` (the filesystem read model still works read-only
  with older state dirs).
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
`events.ndjson` / `final.md` reads, descriptor validation (permissions,
symlinks, name/protocol/ready/control/pid), the control client against a fake
loopback HTTP server (auth, errors, timeout/backoff), the confirmation state
machine, the steer editor (insert/newline/cursor/20 000 limit/window clipping),
the steer scene confirmation and warning lines, owner routing, `requestSteer`
against a fake control server (200, 409 `resume_unavailable`, no-owner local
rejection), and the view-model width limits at 28, 40 and 64 columns.
