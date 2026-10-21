---
description: Delete a terminal job and its files
argument-hint: <job_id> [discard_changes]
allowed-tools: mcp__plugin_agent-workers_agent-workers__worker_delete
---
Delete this job:

$ARGUMENTS

Call `worker_delete` with the supplied job id. Keep `discard_changes` false unless
the user explicitly confirmed discarding uncommitted worktree changes.

If the tool returns `worktree_dirty`, explain that the worktree has changes and
ask before retrying with `discard_changes: true`. Never use shell `rm` or `git`
commands to bypass the MCP deletion path.
