---
description: Show running and queued DSH workers
argument-hint: [job_id ...]
allowed-tools: mcp__dsh-workers__dsh_status
---
Call the `dsh_status` MCP tool.

Arguments: $ARGUMENTS

If arguments contain job ids, pass them as `job_ids`; otherwise omit `job_ids`
and list every known job. Present a compact table with job id, label, status,
steps, tool calls, last tool, elapsed time, and usage. Highlight failed or
terminal jobs.
