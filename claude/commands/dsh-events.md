---
description: Read live step events from a DSH worker
argument-hint: <job_id> [cursor]
allowed-tools: mcp__dsh-workers__dsh_events
---
Call the `dsh_events` MCP tool using the supplied or already-known job id.

Arguments: $ARGUMENTS

Parse the first token as `job_id`. If a second token is present, pass it as the
numeric `cursor`; otherwise use cursor 0. Use limit 200 unless the user asks for
another page size.

Summarize the event timeline by type and phase. Show tool names and short
tool-result previews, but do not dump large inputs or outputs. Always report the
returned `next_cursor` so the next call can read only new events.
