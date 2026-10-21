import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { JobManager } from '../src/jobs.js';

describe('JobManager pi backend', () => {
  let root: string;
  let repo: string;
  let manager: JobManager;
  let config: Config;
  let argvFile: string;
  let stdinFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-pi-test-'));
    repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'README.md'), 'base\n');
    const fake = join(process.cwd(), 'test/fixtures/pi/fake-pi.mjs');
    await chmod(fake, 0o700);
    argvFile = join(root, 'argv.json');
    stdinFile = join(root, 'stdin.txt');
    config = {
      backend: 'pi',
      dshBin: 'true',
      piBin: fake,
      allowedRoots: [repo],
      stateDir: join(root, 'state'),
      worktreeRoot: join(root, 'worktrees'),
      dshHome: join(root, 'dsh-home'),
      control: true,
      maxConcurrent: 1,
      maxQueue: 2,
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      maxDepth: 1,
      retentionDays: 7,
      useDshCredentials: false,
      credentialsFile: join(root, 'credentials.yaml'),
      envAllow: ['PATH', 'HOME', 'PI_FIXTURE', 'PI_ARGV_FILE', 'PI_STDIN_FILE'],
      stallMs: 120_000,
      loopRepeat: 4,
      toolErrorLimit: 5,
      watchdogAction: 'warn',
      piDefaultProfile: 'default',
      piProfilesFile: join(root, 'pi-profiles.json'),
      piModel: 'openrouter/deepseek/deepseek-v4.1-flash-1017:low',
      piThinking: 'low',
      piAgentDir: '',
      piAllowWrite: false,
    };
    await mkdir(config.stateDir);
    await mkdir(config.worktreeRoot);
    await mkdir(config.dshHome);
    process.env.PI_FIXTURE = join(process.cwd(), 'test/fixtures/pi/json-basic.jsonl');
    process.env.PI_ARGV_FILE = argvFile;
    process.env.PI_STDIN_FILE = stdinFile;
    manager = new JobManager(config);
    await manager.init();
  });

  afterAll(async () => {
    await manager.shutdown();
    delete process.env.PI_FIXTURE;
    delete process.env.PI_ARGV_FILE;
    delete process.env.PI_STDIN_FILE;
    await rm(root, { recursive: true, force: true });
  });

  it('runs a pi job over stdin, normalizes events, and reports backend/cost', async () => {
    const started = await manager.start({
      task: 'review this',
      access: 'read-only',
      backend: 'pi',
    });
    expect(started.backend).toBe('pi');
    expect(started.profile).toBe('default');

    const waited = await manager.wait([started.job_id], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');
    const result = await manager.result(started.job_id, 1000, new Set(['final']));
    expect(result.status).toBe('succeeded');
    expect(result.final).toBe('hi');
    expect(result.backend).toBe('pi');
    expect(result.usage).toMatchObject({ inputTokens: 15, outputTokens: 5 });
    expect(result.cost_usd).toBeCloseTo(0.0005, 8);

    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        '--mode',
        'json',
        '--model',
        'openrouter/deepseek/deepseek-v4.1-flash-1017',
        '--thinking',
        'low',
        '--no-mcp',
        '--tools',
        'read,grep,find,ls',
      ]),
    );
    expect(argv).not.toContain('review this');
    expect(await readFile(stdinFile, 'utf8')).toBe('review this');

    const saved = JSON.parse(
      await readFile(join(config.stateDir, 'jobs', started.job_id, 'job.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved.schemaVersion).toBe(1);
    expect(saved.backend).toBe('pi');
    expect(saved.costUsd).toBeCloseTo(0.0005, 8);

    const events = (
      await readFile(join(config.stateDir, 'jobs', started.job_id, 'events.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toContain('tool_call');
    expect(events.map((event) => event.type)).toContain('final');
    expect(events.some((event) => event.type === 'session')).toBe(true);
  });

  it('resumes and steers a pi job in the original session directory', async () => {
    const started = await manager.start({ task: 'first', access: 'read-only' });
    await manager.wait([started.job_id], 'all', 10_000);

    const steered = (await manager.steer({
      job_id: started.job_id,
      message: 'continue',
    })) as Record<string, unknown>;
    expect(steered.cancelled).toBe(false);
    const steeredId = steered.steered_job_id as string;
    const waited = await manager.wait([steeredId], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');

    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
    expect(argv).toContain('--session-id');
    expect(argv).toContain('fixture-session');
    const dirIndex = argv.indexOf('--session-dir');
    expect(dirIndex).toBeGreaterThanOrEqual(0);
    expect(argv[dirIndex + 1]).toBe(join(config.stateDir, 'jobs', started.job_id, 'pi-sessions'));

    const result = await manager.result(steeredId, 1000, new Set(['final']));
    expect(result.final).toBe('hi');
    const saved = JSON.parse(
      await readFile(join(config.stateDir, 'jobs', steeredId, 'job.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved.sessionDir).toBe(join(config.stateDir, 'jobs', started.job_id));
  });

  it('refuses to resume when the shared session directory was deleted', async () => {
    const first = await manager.start({ task: 'first', access: 'read-only' });
    await manager.wait([first.job_id], 'all', 10_000);
    const steered = (await manager.steer({
      job_id: first.job_id,
      message: 'continue',
    })) as Record<string, unknown>;
    const steeredId = steered.steered_job_id as string;
    await manager.wait([steeredId], 'all', 10_000);

    await manager.delete(first.job_id, false);
    await expect(manager.steer({ job_id: steeredId, message: 'again' })).rejects.toMatchObject({
      code: 'resume_unavailable',
    });
  });

  it('treats a successful auto-retry as a success', async () => {
    const previous = process.env.PI_FIXTURE;
    process.env.PI_FIXTURE = join(process.cwd(), 'test/fixtures/pi/json-retry.jsonl');
    try {
      const started = await manager.start({ task: 'retry', access: 'read-only' });
      const waited = await manager.wait([started.job_id], 'all', 10_000);
      expect(waited.jobs[0]?.status).toBe('succeeded');
      const result = await manager.result(started.job_id, 1000, new Set(['final']));
      expect(result.final).toBe('done');
    } finally {
      if (previous === undefined) delete process.env.PI_FIXTURE;
      else process.env.PI_FIXTURE = previous;
    }
  });

  it('reports an output-limit stop as turn_error', async () => {
    const previous = process.env.PI_FIXTURE;
    process.env.PI_FIXTURE = join(process.cwd(), 'test/fixtures/pi/json-length.jsonl');
    try {
      const started = await manager.start({ task: 'length', access: 'read-only' });
      const waited = await manager.wait([started.job_id], 'all', 10_000);
      expect(waited.jobs[0]?.status).toBe('failed');
      expect(waited.jobs[0]?.reason).toBe('turn_error');
      const result = await manager.result(started.job_id, 1000, new Set(['final']));
      expect(result.final).toBe('partial');
    } finally {
      if (previous === undefined) delete process.env.PI_FIXTURE;
      else process.env.PI_FIXTURE = previous;
    }
  });

  it('rejects workspace-write for pi unless the opt-in is enabled', async () => {
    await expect(
      manager.start({ task: 'write', access: 'workspace-write', backend: 'pi' }),
    ).rejects.toMatchObject({ code: 'pi_write_disabled' });
  });

  it('falls back to the pi default profile when the shared profile is a dsh one', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-workers-pi-profile-'));
    const previous = process.env.AGENT_WORKERS_PROFILE;
    process.env.AGENT_WORKERS_PROFILE = 'work-openrouter';
    try {
      const fallbackConfig: Config = {
        ...config,
        stateDir: join(temp, 'state'),
        worktreeRoot: join(temp, 'worktrees'),
        dshHome: join(temp, 'dsh-home'),
      };
      await mkdir(fallbackConfig.stateDir);
      await mkdir(fallbackConfig.worktreeRoot);
      await mkdir(fallbackConfig.dshHome);
      const fallback = new JobManager(fallbackConfig);
      await fallback.init();
      expect((await fallback.profileStatus()).profile).toBe('default');
      await fallback.shutdown();
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKERS_PROFILE;
      else process.env.AGENT_WORKERS_PROFILE = previous;
      await rm(temp, { recursive: true, force: true });
    }
  });
});
