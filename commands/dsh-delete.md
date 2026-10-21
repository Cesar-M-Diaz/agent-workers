---
description: Delete a terminal DSH job and its files
argument-hint: <job_id> [discard_changes]
allowed-tools: mcp__plugin_dsh-workers_dsh-workers__dsh_delete
---
Delete this DSH job:

$ARGUMENTS

Call `dsh_delete` with the supplied job id. Keep `discard_changes` false unless
the user explicitly confirmed discarding uncommitted worktree changes.

If the tool returns `worktree_dirty`, explain that the worktree has changes and
ask before retrying with `discard_changes: true`. Never use shell `rm` or `git`
commands to bypass the MCP deletion path.
