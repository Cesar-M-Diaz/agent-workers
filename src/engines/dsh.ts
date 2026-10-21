import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';
import { resolveApiKey, resolveOpenCodeGoApiKey, resolveOpenRouterChatApiKey } from '../config.js';
import { JobError } from '../errors.js';
import { NdjsonFold } from '../ndjson.js';
import { runCapture } from '../proc.js';
import type {
  Engine,
  EngineLaunchPlan,
  EngineLaunchSpec,
  EngineProfileMetadata,
  Fold,
} from './types.js';

/**
 * DeepSeek Harness adapter. It keeps every dsh-specific detail (profiles,
 * DSH_HOME, permission mode and credentials) behind the Engine interface.
 */
export class DshEngine implements Engine {
  readonly id = 'dsh' as const;
  readonly label = 'DeepSeek Harness';
  readonly defaultProfile = 'work-openrouter';
  readonly supportsResume = true;

  private version = 'unavailable';
  private apiKey: string | undefined;
  private openRouterChatApiKey: string | undefined;
  private openCodeGoApiKey: string | undefined;
  private readonly profileReady = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly baseEnv: (depth: number) => Record<string, string>,
  ) {}

  async init(): Promise<{ version: string }> {
    this.apiKey = await resolveApiKey(this.config);
    this.openRouterChatApiKey = await resolveOpenRouterChatApiKey(this.config);
    this.openCodeGoApiKey = await resolveOpenCodeGoApiKey(this.config);
    const result = await runCapture(this.config.dshBin, ['--version'], { timeoutMs: 10_000 });
    this.version = result.code === 0 ? result.stdout.trim() : 'unavailable';
    return { version: this.version };
  }

  async availableProfiles(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.config.dshHome, 'profiles'), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async resolveProfile(name: string): Promise<string> {
    const profile = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
      throw new JobError('unknown_profile', `invalid profile name: ${profile}`);
    }
    const profiles = await this.availableProfiles();
    if (!profiles.includes(profile)) {
      throw new JobError(
        'unknown_profile',
        `unknown profile ${profile}; available: ${profiles.join(', ') || 'none'}`,
      );
    }
    return profile;
  }

  async readProfileMetadata(profile: string): Promise<EngineProfileMetadata> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.config.dshHome, 'profiles', profile, 'metadata.json'), 'utf8'),
      ) as Record<string, unknown>;
      return {
        ...(typeof raw.provider === 'string' && raw.provider.trim()
          ? { provider: raw.provider.trim() }
          : {}),
        ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim() } : {}),
      };
    } catch {
      return {};
    }
  }

  async ensureReady(profile: string): Promise<void> {
    let ready = this.profileReady.get(profile);
    if (!ready) {
      ready = (async () => {
        const result = await runCapture(this.config.dshBin, ['--profile', profile, '--help'], {
          cwd: this.config.allowedRoots[0],
          env: this.envFor(1, 'read-only'),
          timeoutMs: 30_000,
        });
        if (result.code !== 0) {
          throw new JobError(
            'worker_unavailable',
            `cannot initialize dsh profile ${profile}: ${result.stderr.trim()}`,
          );
        }
      })();
      this.profileReady.set(profile, ready);
      void ready.catch(() => this.profileReady.delete(profile));
    }
    return ready;
  }

  async launch(spec: EngineLaunchSpec, _task: string): Promise<EngineLaunchPlan> {
    const args = ['--profile', spec.profile, '--json'];
    if (spec.sessionId) args.push('--session-id', spec.sessionId);
    return {
      command: this.config.dshBin,
      args,
      env: this.envFor(spec.depth, spec.access),
      taskInput: 'stdin',
    };
  }

  createFold(onEvent: (line: string) => void): Fold {
    return new NdjsonFold(onEvent);
  }

  private envFor(depth: number, access: EngineLaunchSpec['access']): Record<string, string> {
    const env = this.baseEnv(depth);
    env.DSH_HOME = this.config.dshHome;
    env.DSH_PERMISSION_MODE = access === 'workspace-write' ? 'workspace-write' : 'read-only';
    env.DSH_TELEMETRY_DISABLED = '1';
    if (this.apiKey) env.DEEPSEEK_API_KEY = this.apiKey;
    if (this.openRouterChatApiKey) env.OPENROUTER_CHAT_API_KEY = this.openRouterChatApiKey;
    if (this.openCodeGoApiKey) env.OPENCODE_GO_API_KEY = this.openCodeGoApiKey;
    return env;
  }
}
