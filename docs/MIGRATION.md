# Migrating from dsh-workers to agent-workers

The plugin was renamed because it now runs more than one backend. The dsh
backend is still supported; `pi` is the second backend.

## What changed

| Before | After |
| --- | --- |
| Plugin `dsh-workers` | Plugin `agent-workers` |
| Commands `/dsh-workers:dsh-start` | Commands `/agent-workers:start` |
| Tools `dsh_start`, `dsh_status`, ... | Tools `worker_start`, `worker_status`, ... |
| Skill `dsh-parallel` | Skill `agent-workers:parallel` |
| Env `DSH_WORKERS_*` | Env `AGENT_WORKERS_*` (old names accepted for one release) |
| State `~/.local/state/dsh-workers` | Reused if it exists; new default `~/.local/state/agent-workers` |
| Pane title `DSH Workers` | `Agent Workers` |

The `dsh` backend, `dsh --profile`, `dsh_bin`, `DSH_HOME` and the dsh
credential handling keep their names: they belong to that backend, not to the
plugin.

## Steps

1. Install the new plugin:
   `/plugin install agent-workers@agent-workers`
2. Recreate the plugin settings in the new plugin. `pluginConfigs` is keyed by
   plugin id and does not migrate automatically.
3. Update permission rules that mention the old MCP server:
   `mcp__plugin_dsh-workers_dsh-workers__...` ->
   `mcp__plugin_agent-workers_agent-workers__...`.
4. Rename environment variables if you set them outside the plugin. The code
   reads `AGENT_WORKERS_*` first and falls back to `DSH_WORKERS_*`.
5. Replace slash commands, tool names and the skill in prompts and scripts.
6. Remove the old plugin: `/plugin uninstall dsh-workers`.
   The optional `dsh-workers` entry in this marketplace is only a
   compatibility notice and has no MCP server.

## State directory

Existing jobs stay readable. The new default prefers
`~/.local/state/dsh-workers` when that directory already exists, so the pane
and dashboard keep showing old and new jobs. Set `state_dir` (or
`AGENT_WORKERS_STATE_DIR`) to choose explicitly.

Do not run the old and new MCP servers at the same time against the same state
directory: both would load the same jobs.
