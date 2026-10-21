---
description: Switch the worker profile for this session
argument-hint: work-openrouter | personal-deepseek | personal-opencode
allowed-tools: mcp__plugin_agent-workers_agent-workers__worker_profile
---
Switch the worker profile for this MCP session.

Profile: $ARGUMENTS

Call `worker_profile` with the profile named above. If no profile was provided, call
`worker_profile` with no arguments and report the current profile and the available
ones. Do not start a worker.
