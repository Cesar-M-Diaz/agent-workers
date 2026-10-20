---
description: Start a DSH worker with a self-contained task
argument-hint: <self-contained task>
allowed-tools: mcp__dsh-workers__dsh_start
---
Start a DeepSeek Harness worker for this task:

$ARGUMENTS

Call the `dsh_start` MCP tool. Derive a short 3-5 word label. Default to
`access: "read-only"`. Use `access: "workspace-write"` with
`isolation: "worktree"` only when the task clearly requires file changes.

The worker does not see this conversation, so if the supplied task is missing
context, add the minimum relevant paths and constraints before starting it.
Report the job id, status, cwd, and worktree path if present. Do not wait unless
the user asked you to.
