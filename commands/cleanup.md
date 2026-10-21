---
description: Clean a terminal worktree without deleting its job
argument-hint: <job_id> [discard]
allowed-tools: mcp__plugin_agent-workers_agent-workers__worker_cleanup
---
Clean the worktree for this job:

$ARGUMENTS

Pass the supplied or already-known job id to `worker_cleanup`. Keep
`discard_changes` false unless the user explicitly said to discard changes.
Report whether the worktree was removed and whether the branch was deleted.

Use `/dsh-delete <job_id>` instead when the job record should be removed too.
