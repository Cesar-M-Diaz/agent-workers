# dsh-workers

A standalone local stdio MCP server and Claude Code skill for running DeepSeek
Harness (`dsh`) headless workers in parallel.

This is an independent personal project. It is not an official DeepSeek package
and is not part of N|Solid or NodeSource.

The server uses one `dsh --profile headless --json` process per job. It provides
a bounded FIFO queue, wall-clock timeouts, process-group cancellation, optional
git worktree isolation, and artifact-based results.

```text
Claude Code / Codex
  └── MCP "dsh-workers"
        └── one dsh --profile headless --json process per job
              └── DeepSeek
```

These workers are separate DSH processes. They are not Claude `Task` calls and
do not appear in the DSH TUI native subagent side panel.

## Requirements

- Node 24+
- pnpm 10+
- `dsh` and a DeepSeek credential available to the worker process
- Writable state and DSH home directories

## Build and test

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Headless credentials

The headless profile disables the DSH managed credential store. A worker can
receive `DEEPSEEK_API_KEY` explicitly, read a project `.env`, or read the
current DSH credential reference when `DSH_WORKERS_USE_DSH_CREDENTIALS=1`.

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

## Configuration

All policy is server-side. Tool arguments cannot choose the binary, environment,
DSH home, patches, or unrestricted permissions.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_WORKERS_DSH_BIN` | `dsh` | Absolute path recommended. |
| `DSH_WORKERS_ALLOWED_ROOTS` | MCP process cwd | Colon- or comma-separated directories. |
| `DSH_WORKERS_STATE_DIR` | `$TMPDIR/dsh-workers` | Job metadata and logs; mode 0700. |
| `DSH_WORKERS_WORKTREE_ROOT` | `<state>/worktrees` | Git worktrees created by the server. |
| `DSH_WORKERS_DSH_HOME` | `<state>/dsh-home` | Shared DSH profile and session store. |
| `DSH_WORKERS_MAX_CONCURRENT` | `3` | Hard maximum 8. |
| `DSH_WORKERS_MAX_QUEUE` | `16` | Bounded queue. |
| `DSH_WORKERS_DEFAULT_TIMEOUT_S` | `1200` | Default per-job wall clock. |
| `DSH_WORKERS_MAX_TIMEOUT_S` | `3600` | Tool argument ceiling. |
| `DSH_WORKERS_MAX_DEPTH` | `2` | Recursion guard through `DSH_WORKERS_DEPTH`. |
| `DSH_WORKERS_USE_DSH_CREDENTIALS` | off | Read `DEEPSEEK_API_KEY` from the configured credential file. |
| `DSH_WORKERS_CREDENTIALS_FILE` | `~/.dsh/.credentials.yaml` | Used only when the credential opt-in is on. |
| `DSH_WORKERS_ENV_ALLOW` | empty | Extra environment variable names allowed into workers. |

The server passes a small environment allowlist to workers and always forces
`DSH_PERMISSION_MODE=read-only` or `workspace-write`. It never exposes
`danger-full-access`.

If a configured state directory is on a read-only filesystem, the server logs
`state_dir_fallback` to stderr and uses `$TMPDIR/dsh-workers/{state,worktrees,dsh-home}`
instead. That keeps a user-scoped MCP usable on managed machines with a read-only
home, but the fallback state is temporary.

## MCP tools

- `dsh_start`: start a worker and return a job id immediately.
- `dsh_status`: inspect running and queued jobs.
- `dsh_wait`: wait for any or all jobs, with a bounded timeout.
- `dsh_result`: read the final answer, stderr tail, and worktree diff.
- `dsh_cancel`: cancel a queued or running job.
- `dsh_cleanup`: remove a finished worktree and branch.

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
