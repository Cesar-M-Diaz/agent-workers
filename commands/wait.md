---
description: Wait up to a bounded timeout for workers
argument-hint: <job_id ...>
allowed-tools: mcp__plugin_agent-workers_agent-workers__worker_wait
---
Call the `worker_wait` MCP tool for these jobs:

$ARGUMENTS

Use `mode: "all"` and a moderate timeout, at most 120 seconds unless the user
requested another value. A timeout only detaches the wait; it does not cancel
the workers. Report which jobs settled and which are still running.
