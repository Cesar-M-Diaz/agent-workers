---
description: Show workers for the current session
argument-hint: [job_id ...]
allowed-tools: mcp__plugin_agent-workers_agent-workers__worker_status
---
Call the `worker_status` MCP tool.

Arguments: $ARGUMENTS

If job ids are present in the arguments or already known from this conversation,
pass them as `job_ids` automatically. Do not ask the user to type a job id that
the conversation already contains. If no ids are available and the user asks for
all work, omit `job_ids`.

Present a compact table grouped by parent session with job id, label, status,
steps, tool calls, last tool, elapsed time, and usage.
