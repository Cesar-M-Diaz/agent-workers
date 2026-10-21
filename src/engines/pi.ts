import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';
import { JobError } from '../errors.js';
import { runCapture } from '../proc.js';
import { PiFold } from './pi-fold.js';
import type {
  Engine,
  EngineLaunchPlan,
  EngineLaunchSpec,
  EngineProfileMetadata,
  Fold,
} from './types.js';

interface PiProfile {
  provider?: string;
  model?: string;
  thinking?: string;
}

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function parseModel(value: string): EngineProfileMetadata {
  let text = value.trim();
  let thinking: string | undefined;
  const colon = text.lastIndexOf(':');
  const suffix = colon > 0 ? text.slice(colon + 1).toLowerCase() : '';
  if (colon > 0 && THINKING_LEVELS.has(suffix)) {
    thinking = suffix;
    text = text.slice(0, colon);
  }
  const slash = text.indexOf('/');
  if (slash > 0) {
    return {
      provider: text.slice(0, slash),
      model: text.slice(slash + 1),
      ...(thinking ? { thinking } : {}),
    };
  }
  return { ...(text ? { model: text } : {}), ...(thinking ? { thinking } : {}) };
}

/**
 * pi adapter. pi has no named profiles of its own, so a profile is either the
 * literal 'default' (use pi's configured model), a model pattern such as
 * "openrouter/deepseek/deepseek-v4.1-flash-1017:low", or a key in the optional
 * pi-profiles.json file under the worker state directory.
 */
export class PiEngine implements Engine {
  readonly id = 'pi' as const;
  readonly label = 'pi';
  readonly defaultProfile = 'default';
  // Resume/steer need the original job's session directory; that is phase 3.
  readonly supportsResume = false;

  private version = 'unavailable';
  private profiles: Record<string, PiProfile> = {};

  constructor(
    private readonly config: Config,
    private readonly baseEnv: (depth: number) => Record<string, string>,
  ) {}

  async init(): Promise<{ version: string }> {
    this.profiles = await this.loadProfiles();
    const result = await runCapture(this.config.piBin ?? 'pi', ['--version'], {
      timeoutMs: 10_000,
    });
    this.version = result.code === 0 ? result.stdout.trim() : 'unavailable';
    return { version: this.version };
  }

  async availableProfiles(): Promise<string[]> {
    return ['default', ...Object.keys(this.profiles).sort()];
  }

  async resolveProfile(name: string): Promise<string> {
    const profile = name.trim() || 'default';
    if (profile === 'default' || profile in this.profiles) return profile;
    // A bare model pattern is a valid pi profile.
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/.test(profile)) return profile;
    throw new JobError(
      'unknown_profile',
      `unknown pi profile ${profile}; available: ${(await this.availableProfiles()).join(', ')}`,
    );
  }

  async readProfileMetadata(profile: string): Promise<EngineProfileMetadata> {
    const entry = this.profiles[profile];
    if (entry) {
      return {
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
      };
    }
    if (profile === 'default') {
      return this.config.piModel?.trim() ? parseModel(this.config.piModel) : {};
    }
    return parseModel(profile);
  }

  async ensureReady(): Promise<void> {
    if (this.version === 'unavailable') {
      throw new JobError(
        'pi_unavailable',
        'pi is not available; check the pi binary and its configuration',
      );
    }
  }

  async launch(spec: EngineLaunchSpec, _task: string): Promise<EngineLaunchPlan> {
    const metadata = await this.readProfileMetadata(spec.profile);
    const modelArg =
      metadata.provider && metadata.model
        ? `${metadata.provider}/${metadata.model}`
        : metadata.model;
    const thinking =
      metadata.thinking ??
      (spec.profile === 'default' ? this.config.piThinking?.trim() : undefined);
    if (thinking && !THINKING_LEVELS.has(thinking)) {
      throw new JobError(
        'unknown_profile',
        `invalid pi thinking level ${thinking}; expected off, minimal, low, medium, high, xhigh or max`,
      );
    }

    const args = ['--mode', 'json'];
    if (modelArg) args.push('--model', modelArg);
    if (thinking) args.push('--thinking', thinking);
    args.push(
      '--no-extensions',
      '--no-skills',
      '--no-mcp',
      '--no-context-files',
      '--no-approve',
      '--session-dir',
      join(spec.sessionDir, 'pi-sessions'),
      '--tools',
      spec.access === 'workspace-write' ? 'read,bash,edit,write' : 'read,grep,find,ls',
    );
    if (spec.sessionId) args.push('--session-id', spec.sessionId);

    const env = this.baseEnv(spec.depth);
    const agentDir = this.config.piAgentDir?.trim();
    if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
    return {
      command: this.config.piBin ?? 'pi',
      args,
      env,
      taskInput: 'stdin',
    };
  }

  createFold(onEvent: (line: string) => void): Fold {
    return new PiFold(onEvent);
  }

  private async loadProfiles(): Promise<Record<string, PiProfile>> {
    const file = this.config.piProfilesFile;
    if (!file) return {};
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const result: Record<string, PiProfile> = {};
      for (const [name, value] of Object.entries(raw)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        result[name] = {
          ...(typeof entry.provider === 'string' && entry.provider.trim()
            ? { provider: entry.provider.trim() }
            : {}),
          ...(typeof entry.model === 'string' && entry.model.trim()
            ? { model: entry.model.trim() }
            : {}),
          ...(typeof entry.thinking === 'string' && entry.thinking.trim()
            ? { thinking: entry.thinking.trim() }
            : {}),
        };
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${JSON.stringify({ event: 'pi_profiles_unreadable', file, error: message })}\n`,
      );
      return {};
    }
  }
}
