---
description: Steer a running or finished DSH worker with a self-contained instruction
argument-hint: <job_id> <message>
allowed-tools: mcp__dsh-workers__dsh_steer
---
Steer this DSH worker:

$ARGUMENTS

Parse the first token as `job_id`; everything after it is the steering message.
If either is missing, ask for the missing part and stop.

Call the `dsh_steer` MCP tool with the supplied job id and message. Passing
`timeout_s` is optional; omit it to inherit the original job's timeout.

The steered worker resumes the original DSH session, but it does not see this
conversation, the parent chat history, or any file you read without mentioning
it. Rewrite the message so it is fully self-contained: state the reason for the
correction, the exact expected behavior, relevant paths, and any constraints.

Report the original job id (`job_id`), the new `steered_job_id`, whether the
original was cancelled (`cancelled`), the new status, label, group, and cwd.
Keep both ids for later status, events, result, and cleanup calls.
