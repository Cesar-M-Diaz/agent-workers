---
description: Clean a terminal DSH worktree without deleting its job
argument-hint: <job_id> [discard]
allowed-tools: mcp__dsh-workers__dsh_cleanup
---
Clean the worktree for this DSH job:

$ARGUMENTS

Pass the supplied or already-known job id to `dsh_cleanup`. Keep
`discard_changes` false unless the user explicitly said to discard changes.
Report whether the worktree was removed and whether the branch was deleted.

Use `/dsh-delete <job_id>` instead when the job record should be removed too.
