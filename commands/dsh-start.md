---
description: Start a DSH worker in the current session group
argument-hint: <self-contained task>
allowed-tools: mcp__plugin_dsh-workers_dsh-workers__dsh_group, mcp__plugin_dsh-workers_dsh-workers__dsh_start
---
Start a DeepSeek Harness worker for this task:

$ARGUMENTS

First call `dsh_group` with no arguments. If the returned `group_name` is generic
or does not describe this work, call `dsh_group` with a concise 3-6 word
`group_name`. Reuse the returned `group_id` and `group_name`.

Call `dsh_start` and always pass:
- `group_id`: the returned group id
- `group_name`: the returned group name
- `label`: a short 3-5 word job label
- `task`: the self-contained task above

Default to `access: "read-only"`. Use `access: "workspace-write"` with
`isolation: "worktree"` only when the task clearly requires file changes.

If the user explicitly names a profile, pass it as `profile` (for example
`personal-deepseek`); otherwise omit it and use the session default.

The worker does not see this conversation, so add the minimum relevant paths and
constraints before starting it. Report the job id, group, status, cwd, and
worktree path if present. Keep the job id for later status, events, result,
cleanup, or delete calls.
