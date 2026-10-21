import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StateDirSources {
  /** The plugin's `stateDir` config; blank counts as unset. */
  stateDir?: string | undefined;
  env?: NodeJS.ProcessEnv;
  home?: string | undefined;
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Contract §2 order: explicit config, AGENT_WORKERS_STATE_DIR,
 * DSH_WORKERS_STATE_DIR, an existing legacy dsh-workers directory, then
 * agent-workers under XDG_STATE_HOME or ~/.local/state.
 */
export function resolveStateDir(sources: StateDirSources = {}): string {
  const explicit = nonBlank(sources.stateDir);
  if (explicit !== undefined) return explicit;

  const env = sources.env ?? process.env;
  const dedicated = nonBlank(env.AGENT_WORKERS_STATE_DIR) ?? nonBlank(env.DSH_WORKERS_STATE_DIR);
  if (dedicated !== undefined) return dedicated;

  const home = nonBlank(sources.home) ?? homedir();
  const base = nonBlank(env.XDG_STATE_HOME) ?? join(home, '.local', 'state');
  const legacy = join(base, 'dsh-workers');
  return isDirectory(legacy) ? legacy : join(base, 'agent-workers');
}
