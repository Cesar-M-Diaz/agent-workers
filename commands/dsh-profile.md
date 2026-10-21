---
description: Switch the DSH worker profile for this session
argument-hint: work-openrouter | personal-deepseek | personal-opencode
allowed-tools: mcp__plugin_dsh-workers_dsh-workers__dsh_profile
---
Switch the DSH worker profile for this MCP session.

Profile: $ARGUMENTS

Call `dsh_profile` with the profile named above. If no profile was provided, call
`dsh_profile` with no arguments and report the current profile and the available
ones. Do not start a worker.
