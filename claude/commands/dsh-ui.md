---
description: Open the live DSH workers dashboard
allowed-tools: Bash(node:*)
---
Run this exact Bash command:

```sh
node /home/cesardiaz/projects/dsh-workers/dist/ui.js --detach --open
```

The command starts the dashboard if needed and prints its local URL. Report the
URL and tell the user the dashboard is read-only; worker cancellation and
cleanup still use the MCP commands.
