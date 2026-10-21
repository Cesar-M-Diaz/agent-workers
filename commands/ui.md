---
description: Start, stop, restart, or inspect the workers dashboard
argument-hint: "[start|stop|status|restart]"
allowed-tools: Bash(node:*)
---
The requested dashboard action is: $ARGUMENTS

Use the standalone UI command:

```sh
node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs" <action>
```

Map the action as follows:

- empty or `start`:
  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs" --detach --open
  ```
- `stop`:
  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs" --stop
  ```
- `status`:
  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/ui.mjs" --status
  ```
- `restart`: run `--stop` first, then `--detach --open`.

Report the command output. The dashboard is only a monitor: stopping it does not
stop workers or the MCP server.
