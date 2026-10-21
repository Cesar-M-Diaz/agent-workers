import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { runCapture } from '../src/proc.js';

const fakeDsh = `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
if (process.argv.includes('--help') || process.argv.includes('--version')) {
  process.stdout.write('fake dsh 0.0.0\\n');
  process.exit(0);
}
const emit = (value) => console.log(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  if (!prompt.includes('NO_SESSION')) {
    emit({ type: 'session', sessionId: 'session-' + process.pid, cwd: process.cwd() });
  }
  if (prompt.includes('LOOP_DELAY')) {
    await sleep(250);
    for (let i = 0; i < 5; i += 1) {
      emit({ type: 'tool_call', callId: 'loop-' + i, tool: 'bash', input: { command: 'pnpm test' } });
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('HANG')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('STEPS')) {
    for (let i = 0; i < 3; i += 1) emit({ type: 'status', phase: 'step_start', step: i });
    await sleep(800);
  }
  if (prompt.includes('WRITE')) {
    await writeFile('worker-output.txt', 'from worker\\n');
  }
  if (prompt.includes('ENV')) {
    await writeFile('worker-env.json', JSON.stringify({
      deepseek: process.env.DEEPSEEK_API_KEY ?? null,
      openrouter: process.env.OPENROUTER_CHAT_API_KEY ?? null,
      opencode: process.env.OPENCODE_GO_API_KEY ?? null,
    }));
  }
  if (prompt.includes('PROFILE')) {
    await writeFile('worker-argv.json', JSON.stringify(process.argv));
  }
  await sleep(300);
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  emit({ type: 'final', text: 'OK ' + prompt.trim() });
});
`;

describe('JobManager', () => {
  let root: string;
  let repo: string;
  let manager: JobManager;
  let config: Config;
  let previousProfileEnv: string | undefined;

  beforeAll(async () => {
    previousProfileEnv = process.env.AGENT_WORKERS_PROFILE;
    delete process.env.AGENT_WORKERS_PROFILE;
    root = await mkdtemp(join(tmpdir(), 'agent-workers-test-'));
    repo = join(root, 'repo');
    await mkdir(repo);
    await runCapture('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'base\n');
    await runCapture('git', ['-C', repo, 'add', '.']);
    await runCapture('git', [
      '-C',
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-qm',
      'base',
    ]);
    const fake = join(root, 'fake-dsh.mjs');
    await writeFile(fake, fakeDsh, { mode: 0o700 });
    await chmod(fake, 0o700);
    config = {
      dshBin: fake,
      allowedRoots: [repo],
      stateDir: join(root, 'state'),
      worktreeRoot: join(root, 'worktrees'),
      dshHome: join(root, 'dsh-home'),
      control: true,
      maxConcurrent: 1,
      maxQueue: 4,
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      maxDepth: 2,
      retentionDays: 7,
      useDshCredentials: true,
      credentialsFile: join(root, 'credentials.yaml'),
      envAllow: ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'],
      stallMs: 120_000,
      loopRepeat: 4,
      toolErrorLimit: 5,
      watchdogAction: 'warn',
    };
    await mkdir(config.stateDir);
    await mkdir(config.worktreeRoot);
    await mkdir(config.dshHome);
    const profileMetadata: Record<string, { provider: string; model: string }> = {
      'work-openrouter': { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' },
      'personal-deepseek': { provider: 'deepseek-official', model: 'deepseek-flash' },
      'personal-opencode': { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    };
    for (const [profile, metadata] of Object.entries(profileMetadata)) {
      const dir = join(config.dshHome, 'profiles', profile);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata));
    }
    await writeFile(
      config.credentialsFile,
      'refs:\n  DEEPSEEK_API_KEY: ds-test\n  OPENROUTER_CHAT_API_KEY: or-test\n  OPENCODE_GO_API_KEY: oc-test\n',
    );
    manager = new JobManager(config);
    await manager.init();
  });

  afterAll(async () => {
    await manager.shutdown();
    if (previousProfileEnv === undefined) delete process.env.AGENT_WORKERS_PROFILE;
    else process.env.AGENT_WORKERS_PROFILE = previousProfileEnv;
    await rm(root, { recursive: true, force: true });
  });

  it('starts asynchronously, queues past the concurrency cap, and returns final text', async () => {
    const first = await manager.start({
      task: 'first',
      access: 'read-only',
      group_id: 'group-test',
      group_name: 'Group test',
    });
    const second = await manager.start({ task: 'second', access: 'read-only' });
    await delay(50);
    const status = await manager.statusOutput([first.job_id, second.job_id]);
    expect(status.server.running).toBe(1);
    expect(status.server.queued).toBe(1);
    expect(status.server.group_id).toBe(manager.groupStatus().group_id);
    expect(status.jobs.some((job) => job.group_name === 'Group test')).toBe(true);
    expect(status.jobs.some((job) => job.status === 'queued')).toBe(true);

    const waited = await manager.wait([first.job_id, second.job_id], 'all', 10_000);
    expect(waited.timed_out).toBe(false);
    expect(waited.jobs.every((job) => job.status === 'succeeded')).toBe(true);

    const result = await manager.result(first.job_id, 1000, new Set(['final']));
    expect(result.final).toBe('OK first');
  });

  it('writes job.json atomically, leaving no temporary files', async () => {
    const started = await manager.start({ task: 'atomic', access: 'read-only' });
    await manager.wait([started.job_id], 'all', 10_000);
    const dir = join(config.stateDir, 'jobs', started.job_id);
    const saved = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) as {
      id: string;
      status: string;
    };
    expect(saved).toMatchObject({ id: started.job_id, status: 'succeeded' });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes job.json writes so the last state always wins', async () => {
    const started = await manager.start({ task: 'serialized', access: 'read-only' });
    await manager.wait([started.job_id], 'all', 10_000);
    const internals = manager as unknown as {
      jobs: Map<string, { label?: string }>;
      writeJob(job: unknown): Promise<void>;
    };
    const job = internals.jobs.get(started.job_id);
    if (!job) throw new Error('job not loaded');
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) {
      job.label = `write-${i}`;
      writes.push(internals.writeJob(job));
    }
    await Promise.all(writes);
    const dir = join(config.stateDir, 'jobs', started.job_id);
    const saved = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) as { label: string };
    expect(saved.label).toBe('write-19');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('isolates a write in a git worktree, reports the diff, and preserves dirty worktrees', async () => {
    const started = await manager.start({
      task: 'WRITE a file',
      access: 'workspace-write',
      isolation: 'worktree',
    });
    expect(started.worktree).not.toBeNull();
    const waited = await manager.wait([started.job_id], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');
    const result = await manager.result(started.job_id, 5000, new Set(['final', 'diff']));
    const changes = result.changes as { files: Array<{ path: string }>; diff: string };
    expect(changes.files.some((file) => file.path === 'worker-output.txt')).toBe(true);
    expect(changes.diff).toContain('worker-output.txt');

    const preserved = await manager.cleanup(started.job_id, false);
    expect(preserved.worktree).toBe('preserved_dirty');
    const removed = await manager.cleanup(started.job_id, true);
    expect(removed.worktree).toBe('removed');
  });

  it('cancels a running job and settles it', async () => {
    const started = await manager.start({ task: 'HANG', access: 'read-only' });
    await delay(200);
    const cancelled = await manager.cancel(started.job_id);
    expect(cancelled.status).toBe('cancelled');
    const result = await manager.result(started.job_id, 1000, new Set(['final']));
    expect(result.status).toBe('cancelled');
  });

  it('passes provider credentials to the worker environment', async () => {
    // A credential exported in the developer's shell would win over the test's
    // credentials file, so build a manager with those variables removed. The
    // values are restored without ever being printed.
    const names = ['DEEPSEEK_API_KEY', 'OPENROUTER_CHAT_API_KEY', 'OPENCODE_GO_API_KEY'] as const;
    const saved = new Map<string, string | undefined>();
    const isolatedRoot = await mkdtemp(join(root, 'credentials-'));
    const isolatedConfig: Config = {
      ...config,
      stateDir: join(isolatedRoot, 'state'),
      worktreeRoot: join(isolatedRoot, 'worktrees'),
    };
    await mkdir(isolatedConfig.stateDir, { recursive: true });
    await mkdir(isolatedConfig.worktreeRoot, { recursive: true });
    let isolated: JobManager | undefined;
    try {
      for (const name of names) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
      isolated = new JobManager(isolatedConfig);
      await isolated.init();
      const started = await isolated.start({ task: 'ENV', access: 'read-only' });
      const waited = await isolated.wait([started.job_id], 'all', 10_000);
      expect(waited.jobs[0]?.status).toBe('succeeded');
      const env = JSON.parse(await readFile(join(repo, 'worker-env.json'), 'utf8')) as {
        deepseek: string | null;
        openrouter: string | null;
        opencode: string | null;
      };
      expect(env).toEqual({ deepseek: 'ds-test', openrouter: 'or-test', opencode: 'oc-test' });
    } finally {
      await isolated?.shutdown();
      for (const name of names) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('switches the session profile and passes it to dsh', async () => {
    const initial = await manager.profileStatus();
    expect(initial.profile).toBe('work-openrouter');
    expect(initial.provider).toBe('openrouter');
    expect(initial.model).toBe('~deepseek/deepseek-flash-latest');
    expect(initial.profiles).toEqual(['personal-deepseek', 'personal-opencode', 'work-openrouter']);
    try {
      const switched = await manager.setProfile('personal-opencode');
      expect(switched.profile).toBe('personal-opencode');
      const started = await manager.start({ task: 'PROFILE', access: 'read-only' });
      expect(started.profile).toBe('personal-opencode');
      expect(started.provider).toBe('opencode-go');
      expect(started.model).toBe('deepseek-v4.1-flash');
      const waited = await manager.wait([started.job_id], 'all', 10_000);
      expect(waited.jobs[0]?.status).toBe('succeeded');
      expect(waited.jobs[0]?.profile).toBe('personal-opencode');
      const argv = JSON.parse(await readFile(join(repo, 'worker-argv.json'), 'utf8')) as string[];
      expect(argv).toEqual(expect.arrayContaining(['--profile', 'personal-opencode']));
    } finally {
      await manager.setProfile('work-openrouter');
    }
  });

  it('allows a per-job profile override without changing the session profile', async () => {
    const started = await manager.start({
      task: 'PROFILE',
      access: 'read-only',
      profile: 'personal-deepseek',
    });
    expect(started.profile).toBe('personal-deepseek');
    expect(started.provider).toBe('deepseek-official');
    expect(started.model).toBe('deepseek-flash');
    const waited = await manager.wait([started.job_id], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');
    expect(waited.jobs[0]?.profile).toBe('personal-deepseek');
    const argv = JSON.parse(await readFile(join(repo, 'worker-argv.json'), 'utf8')) as string[];
    expect(argv).toEqual(expect.arrayContaining(['--profile', 'personal-deepseek']));
    expect((await manager.profileStatus()).profile).toBe('work-openrouter');
  });

  it('rejects an unknown profile', async () => {
    await expect(manager.setProfile('does-not-exist')).rejects.toMatchObject({
      code: 'unknown_profile',
    });
  });

  it('rejects cwd outside allowed roots', async () => {
    await expect(manager.start({ task: 'x', cwd: '/etc' })).rejects.toMatchObject({
      code: 'cwd_outside_roots',
    });
  });

  it('fails fast when two writers overlap the same tree', async () => {
    const first = await manager.start({
      task: 'HANG writer',
      access: 'workspace-write',
      isolation: 'none',
    });
    await expect(
      manager.start({ task: 'second writer', access: 'workspace-write', isolation: 'none' }),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await manager.cancel(first.job_id);
  });

  it('steers a running job by cancelling it and resuming its session', async () => {
    const original = await manager.start({
      task: 'HANG',
      label: 'steer-me',
      access: 'read-only',
      group_id: 'g_steer',
      group_name: 'Steer group',
    });
    await delay(300);
    const before = await manager.statusOutput([original.job_id]);
    const sessionId = before.jobs[0]?.session_id;
    expect(sessionId).toMatch(/^session-/);

    const steered = await manager.steer({
      job_id: original.job_id,
      message: 'PROFILE continue with the fix',
    });
    const steeredJobId = steered.steered_job_id as string;
    expect(steered).toMatchObject({
      job_id: original.job_id,
      cancelled: true,
      label: 'steer-me ↻',
      group_id: 'g_steer',
      group_name: 'Steer group',
      steered_from: original.job_id,
    });

    const originalResult = await manager.result(original.job_id, 1000, new Set(['final']));
    expect(originalResult.status).toBe('cancelled');
    expect(originalResult.reason).toBe('steered');

    const waited = await manager.wait([steeredJobId], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');
    const result = await manager.result(steeredJobId, 20_000, new Set(['final']));
    expect(result.final).toContain('The supervisor interrupted your previous run to steer you.');
    expect(result.final).toContain('New instruction:\nPROFILE continue with the fix');

    const argv = JSON.parse(await readFile(join(repo, 'worker-argv.json'), 'utf8')) as string[];
    expect(argv).toEqual(expect.arrayContaining(['--session-id', sessionId as string]));

    const saved = JSON.parse(
      await readFile(join(config.stateDir, 'jobs', steeredJobId, 'job.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved.steeredFrom).toBe(original.job_id);
    expect(saved.resumeOf).toBe(original.job_id);
    expect(saved.label).toBe('steer-me ↻');
    expect(saved.groupId).toBe('g_steer');
    expect(saved.groupName).toBe('Steer group');
    expect(saved.timeoutMs).toBe(60_000);
  });

  it('steers a terminal job without cancelling and stacks the arrow label', async () => {
    const original = await manager.start({ task: 'terminal task', label: 'terminal-job' });
    await manager.wait([original.job_id], 'all', 10_000);

    const steered = await manager.steer({
      job_id: original.job_id,
      message: 'follow up',
    });
    const firstResumed = steered.steered_job_id as string;
    expect(steered.cancelled).toBe(false);
    expect(steered.label).toBe('terminal-job ↻');
    expect((await manager.result(original.job_id, 1000, new Set(['final']))).status).toBe(
      'succeeded',
    );
    await manager.wait([firstResumed], 'all', 10_000);

    const again = await manager.steer({
      job_id: firstResumed,
      message: 'follow up again',
    });
    expect(again.cancelled).toBe(false);
    expect(again.label).toBe('terminal-job ↻2');
    await manager.wait([again.steered_job_id as string], 'all', 10_000);
  });

  it('refuses to steer a job that has no session id without touching it', async () => {
    const original = await manager.start({ task: 'NO_SESSION quick', label: 'no-session' });
    await manager.wait([original.job_id], 'all', 10_000);

    await expect(
      manager.steer({ job_id: original.job_id, message: 'resume please' }),
    ).rejects.toMatchObject({ code: 'resume_unavailable' });

    const after = await manager.result(original.job_id, 1000, new Set(['final']));
    expect(after.status).toBe('succeeded');
    const saved = JSON.parse(
      await readFile(join(config.stateDir, 'jobs', original.job_id, 'job.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved.status).toBe('succeeded');
    expect(saved.label).toBe('no-session');
  });

  it('does not resume twice when two steers race for the same job', async () => {
    const original = await manager.start({ task: 'HANG', label: 'race-job' });
    await delay(300);
    const results = await Promise.allSettled([
      manager.steer({ job_id: original.job_id, message: 'PROFILE first steer' }),
      manager.steer({ job_id: original.job_id, message: 'PROFILE second steer' }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Record<string, unknown>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]?.reason as { code?: string } | undefined;
    expect(reason?.code).toBe('resume_unavailable');

    const steeredJobId = fulfilled[0]?.value.steered_job_id as string;
    const waited = await manager.wait([steeredJobId], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');
    expect((await manager.result(original.job_id, 1000, new Set(['final']))).reason).toBe(
      'steered',
    );
  });

  it('cancels a budget-exceeding job with budget_exceeded when the action is cancel', async () => {
    const savedMaxSteps = config.maxSteps;
    const savedAction = config.watchdogAction;
    config.maxSteps = 1;
    config.watchdogAction = 'cancel';
    try {
      const started = await manager.start({ task: 'STEPS', access: 'read-only' });
      await delay(500);
      const before = await manager.statusOutput([started.job_id]);
      expect(before.jobs[0]?.alerts.some((alert) => alert.kind === 'budget')).toBe(true);

      const waited = await manager.wait([started.job_id], 'all', 10_000);
      expect(waited.jobs[0]?.status).toBe('cancelled');
      expect(waited.jobs[0]?.reason).toBe('budget_exceeded');
      expect(waited.jobs[0]?.alerts.some((alert) => alert.kind === 'budget')).toBe(true);
    } finally {
      config.maxSteps = savedMaxSteps;
      config.watchdogAction = savedAction;
    }
  });

  it('worker_wait returns early with alerted when a watched job gains a new alert kind', async () => {
    const started = await manager.start({ task: 'LOOP_DELAY', label: 'loop-wait' });
    const waitStarted = Date.now();
    const waited = await manager.wait([started.job_id], 'all', 5_000);
    expect(waited.timed_out).toBe(false);
    expect(waited.alerted).toContain(started.job_id);
    expect(Date.now() - waitStarted).toBeLessThan(4_000);
    const loop = waited.jobs[0]?.alerts.find((alert) => alert.kind === 'loop');
    expect(loop?.message).toContain('same bash call repeated 5×');
    await manager.cancel(started.job_id);
  });
});
