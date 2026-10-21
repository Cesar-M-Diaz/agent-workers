# State dir fixture

Canonical server read-model fixture. The extracted `dsh-tui-agent-workers` panel
keeps an independent snapshot in the separate `dsh-tui-plugins` workspace. Contract:
`docs/control-protocol.md` §2. Paths inside `job.json` point at `/fixture/state`
and do not exist; pids are not alive.

| Job | Case | Expected reader behavior |
|---|---|---|
| `j_000000000001` | running dsh, worktree, `stalled` alert, owner `owner-live` | events: 1 malformed line skipped, trailing partial line ignored; last text "Running the tests now." |
| `j_000000000002` | queued pi | no events, no final |
| `j_000000000003` | succeeded pi, `costUsd` 0.0005 | final.md shown; usage 15/5 |
| `j_000000000004` | failed, ANSI/OSC/BEL in label, error and stderrTail, two alerts | every string sanitized |
| `j_000000000005` | cancelled `steered`, worktree W5, pi session in its own dir | `worktree_busy` and `session_busy` because of `j_000000000006` |
| `j_000000000006` | running, `resumeOf`/`steeredFrom` 5, same worktree and sessionDir | lineage shown |
| `j_000000000007` | succeeded, `cleaned: true` only at top level | treated as cleaned (no cleanup) |
| `j_000000000008` | interrupted, owner `owner-dead`, group beta | grouped separately |
| `j_000000000009` | running, foreign owner, legacy job.json (no schemaVersion/backend/group/costUsd), `worktree.cleaned` only | backend `dsh`, group "Legacy / ungrouped", cost `n/a`, cleaned |
| `j_00000000000a` | torn job.json | skipped (no previous valid copy) |
| `j_00000000000b` | unknown status `paused` | shown as `unknown` |
| `bad.id` | invalid job id | ignored |
