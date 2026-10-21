import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { DshEngine } from '../src/engines/dsh.js';
import { PiEngine } from '../src/engines/pi.js';
import type { EngineLaunchSpec } from '../src/engines/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    dshBin: 'true',
    piBin: 'true',
    allowedRoots: [process.cwd()],
    stateDir: '/tmp/agent-workers-fixture-state',
    worktreeRoot: '/tmp/agent-workers-fixture-worktrees',
    dshHome: '/tmp/agent-workers-fixture-dsh-home',
    control: true,
    maxConcurrent: 1,
    maxQueue: 1,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 60_000,
    maxDepth: 1,
    retentionDays: 1,
    useDshCredentials: false,
    credentialsFile: '/tmp/agent-workers-fixture-credentials',
    envAllow: ['PATH', 'HOME'],
    stallMs: 120_000,
    loopRepeat: 4,
    toolErrorLimit: 5,
    watchdogAction: 'warn',
    backend: 'pi',
    piDefaultProfile: 'default',
    piProfilesFile: '/tmp/agent-workers-fixture-pi-profiles.json',
    piModel: 'openrouter/deepseek/deepseek-v4.1-flash-1017:low',
    piThinking: 'low',
    piAgentDir: '',
    ...overrides,
  };
}

const spec: EngineLaunchSpec = {
  jobId: 'j_test',
  cwd: '/tmp',
  profile: 'default',
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash-1017',
  access: 'read-only',
  sessionDir: '/tmp/agent-workers-job',
  depth: 0,
};

describe('PiEngine', () => {
  it('parses the default model and launches a read-only JSON run', async () => {
    const engine = new PiEngine(config(), () => ({ PATH: process.env.PATH ?? '' }));
    await engine.init();
    expect(await engine.availableProfiles()).toEqual(['default']);
    expect(await engine.resolveProfile('default')).toBe('default');
    expect(await engine.resolveProfile('openrouter/deepseek/deepseek-v4.1-flash-1017:high')).toBe(
      'openrouter/deepseek/deepseek-v4.1-flash-1017:high',
    );
    expect(await engine.readProfileMetadata('default')).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      thinking: 'low',
    });

    expect(engine.supportsResume).toBe(true);
    const plan = await engine.launch(spec, 'review this');
    expect(plan.taskInput).toBe('stdin');
    expect(plan.args).toEqual([
      '--mode',
      'json',
      '--model',
      'openrouter/deepseek/deepseek-v4.1-flash-1017',
      '--thinking',
      'low',
      '--no-extensions',
      '--no-skills',
      '--no-mcp',
      '--no-context-files',
      '--no-approve',
      '--session-dir',
      join('/tmp/agent-workers-job', 'pi-sessions'),
      '--tools',
      'read,grep,find,ls',
    ]);
  });

  it('loads named profiles from pi-profiles.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-profiles-'));
    const file = join(dir, 'pi-profiles.json');
    await writeFile(
      file,
      JSON.stringify({
        'deep-flash': {
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4.1-flash-1017',
          thinking: 'high',
        },
      }),
    );
    const engine = new PiEngine(config({ piProfilesFile: file }), () => ({}));
    await engine.init();
    expect(await engine.availableProfiles()).toEqual(['default', 'deep-flash']);
    expect(await engine.readProfileMetadata('deep-flash')).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      thinking: 'high',
    });
    const plan = await engine.launch({ ...spec, profile: 'deep-flash' }, 'task');
    expect(plan.args).toContain('openrouter/deepseek/deepseek-v4.1-flash-1017');
    expect(plan.args).toContain('--thinking');
    expect(plan.args).toContain('high');
  });

  it('does not treat a model tag such as :free as a thinking level', async () => {
    const engine = new PiEngine(config(), () => ({}));
    await engine.init();
    expect(await engine.readProfileMetadata('openrouter/qwen/qwen3-coder:free')).toEqual({
      provider: 'openrouter',
      model: 'qwen/qwen3-coder:free',
    });
  });

  it('uses the write toolset when the caller allows workspace writes', async () => {
    const engine = new PiEngine(config(), () => ({}));
    await engine.init();
    const plan = await engine.launch({ ...spec, access: 'workspace-write' }, 'task');
    expect(plan.args).toContain('read,bash,edit,write');
  });

  it('rejects an invalid thinking level before spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-profiles-'));
    const file = join(dir, 'pi-profiles.json');
    await writeFile(
      file,
      JSON.stringify({
        bad: { provider: 'openrouter', model: 'qwen/qwen3-coder', thinking: 'free' },
      }),
    );
    const engine = new PiEngine(config({ piProfilesFile: file }), () => ({}));
    await engine.init();
    await expect(engine.launch({ ...spec, profile: 'bad' }, 'task')).rejects.toMatchObject({
      code: 'unknown_profile',
    });
  });

  it('rejects an unknown non-model profile', async () => {
    const engine = new PiEngine(config(), () => ({}));
    await engine.init();
    await expect(engine.resolveProfile('does-not-exist')).rejects.toMatchObject({
      code: 'unknown_profile',
    });
  });
});

describe('DshEngine', () => {
  it('keeps the dsh launch contract behind the engine interface', async () => {
    const engine = new DshEngine(config({ backend: 'dsh' }), () => ({
      PATH: process.env.PATH ?? '',
    }));
    await engine.init();
    const plan = await engine.launch(
      {
        ...spec,
        profile: 'personal-deepseek',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        access: 'workspace-write',
        sessionId: 'session-1',
      },
      'do the work',
    );
    expect(plan.taskInput).toBe('stdin');
    expect(plan.command).toBe('true');
    expect(plan.args).toEqual([
      '--profile',
      'personal-deepseek',
      '--json',
      '--session-id',
      'session-1',
    ]);
    expect(plan.env.DSH_HOME).toBe('/tmp/agent-workers-fixture-dsh-home');
    expect(plan.env.DSH_PERMISSION_MODE).toBe('workspace-write');
  });
});
