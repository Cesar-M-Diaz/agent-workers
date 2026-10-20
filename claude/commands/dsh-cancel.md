---
description: Cancel a queued or running DSH worker
argument-hint: <job_id>
allowed-tools: mcp__dsh-workers__dsh_cancel
---
Cancel this DSH worker:

$ARGUMENTS

Call the `dsh_cancel` MCP tool with the supplied job id. Confirm the job id and
the resulting status. Do not kill processes with shell commands.
