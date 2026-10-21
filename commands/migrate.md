---
description: Migrate from the old dsh-workers plugin to agent-workers
argument-hint: ""
---
# Migrate from dsh-workers

Tell the user, step by step:

1. Install the renamed plugin from this marketplace:
   `/plugin install agent-workers@agent-workers`
2. Copy the old plugin settings into the new plugin's configuration:
   - `allowed_roots`, `state_dir`, `max_concurrent`
   - `backend` (`dsh` or `pi`)
   - `profile` for the chosen backend
   - the `dsh_*` or `pi_*` settings
3. Update permission rules that name the old MCP server. They look like
   `mcp__plugin_dsh-workers_dsh-workers__...`; replace them with
   `mcp__plugin_agent-workers_agent-workers__...`.
4. Update environment variables from `DSH_WORKERS_*` to `AGENT_WORKERS_*`.
   The old names are still accepted for one release.
5. Replace commands and tool names:
   - `/dsh-workers:dsh-start` -> `/agent-workers:start`
   - `dsh_start` -> `worker_start` (and the other `dsh_*` tools)
   - skill `dsh-parallel` -> `agent-workers:parallel`
6. Remove the old plugin:
   `/plugin uninstall dsh-workers`
7. The state directory is not moved. If `~/.local/state/dsh-workers`
   exists it is reused; otherwise the new default is
   `~/.local/state/agent-workers`.

Do not run two worker servers against the same state directory at once.
