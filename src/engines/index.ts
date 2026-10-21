import type { Config } from '../config.js';
import { DshEngine } from './dsh.js';
import { PiEngine } from './pi.js';
import type { EngineId, EngineSet } from './types.js';

export function createEngines(
  config: Config,
  baseEnv: (depth: number) => Record<string, string>,
): EngineSet {
  const dsh = new DshEngine(config, baseEnv);
  const pi = new PiEngine(config, baseEnv);
  return {
    dsh,
    pi,
    byId(id: EngineId) {
      if (id === 'dsh') return dsh;
      if (id === 'pi') return pi;
      throw new Error(`unknown worker backend: ${String(id)}`);
    },
  };
}
