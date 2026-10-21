---
description: Wait up to a bounded timeout for DSH workers
argument-hint: <job_id ...>
allowed-tools: mcp__plugin_dsh-workers_dsh-workers__dsh_wait
---
Call the `dsh_wait` MCP tool for these jobs:

$ARGUMENTS

Use `mode: "all"` and a moderate timeout, at most 120 seconds unless the user
requested another value. A timeout only detaches the wait; it does not cancel
the workers. Report which jobs settled and which are still running.
