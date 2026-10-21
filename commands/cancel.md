---
description: Cancel a queued or running worker
argument-hint: <job_id>
allowed-tools: mcp__plugin_agent-workers_agent-workers__worker_cancel
---
Cancel this worker:

$ARGUMENTS

Call the `worker_cancel` MCP tool with the supplied job id. Confirm the job id and
the resulting status. Do not kill processes with shell commands.
