---
description: Clean up a terminal DSH worker worktree
argument-hint: <job_id> [discard]
allowed-tools: mcp__dsh-workers__dsh_cleanup
---
Clean up the worktree for this DSH job:

$ARGUMENTS

Call `dsh_cleanup`. `discard_changes` must remain false unless the user
explicitly said to discard changes. Report whether the worktree was removed and
whether the branch was deleted.
