---
description: Open the Agent Workers dashboard focused on one worker
argument-hint: <job_id>
allowed-tools: Bash(node:*)
---
The job id argument is: $ARGUMENTS

Validate that the job id matches `^[A-Za-z0-9_-]+$`. If it is missing or
invalid, ask for a valid job id and stop.

Run this exact Bash command with the validated job id:

```sh
node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs" --detach --open --job <job_id>
```

Report the printed URL.
