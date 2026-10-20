---
description: Start, stop, restart, or inspect the DSH workers dashboard
argument-hint: "[start|stop|status|restart]"
allowed-tools: Bash(node:*)
---
The requested dashboard action is: $ARGUMENTS

Use the standalone UI command:

```sh
node /home/cesardiaz/projects/dsh-workers/dist/ui.js <action>
```

Map the action as follows:

- empty or `start`:
  ```sh
  node /home/cesardiaz/projects/dsh-workers/dist/ui.js --detach --open
  ```
- `stop`:
  ```sh
  node /home/cesardiaz/projects/dsh-workers/dist/ui.js --stop
  ```
- `status`:
  ```sh
  node /home/cesardiaz/projects/dsh-workers/dist/ui.js --status
  ```
- `restart`: run `--stop` first, then `--detach --open`.

Report the command output. The dashboard is only a monitor: stopping it does not
stop workers or the MCP server.
