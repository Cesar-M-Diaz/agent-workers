import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pruneExpiredJobs } from '../src/admin.js';
import type { Config } from '../src/config.js';
import {
  controlDir,
  isOwnerLive,
  liveOwnerIds,
  type OwnerDescriptor,
  pruneStaleDescriptors,
  readDescriptors,
  removeDescriptor,
  writeDescriptor,
} from '../src/control/descriptor.js';
import { JobManager } from '../src/jobs.js';
import { readStartTime, runCapture } from '../src/proc.js';
import { VERSION } from '../src/version.js';

function descriptor(ownerId: string, overrides: Partial<OwnerDescriptor> = {}): OwnerDescriptor {
  return {
    protocol: 'agent-workers-control/1',
    owner_id: ownerId,
    pid: process.pid,
    started_at: new Date().toISOString(),
    version: VERSION,
    state_dir: '/tmp/agent-workers-state',
    control: null,
    ready: true,
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('child process has no pid');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

describe('owner descriptor', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-lease-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes private descriptors atomically and reads them back', async () => {
    const path = join(controlDir(root), 'owner-a.json');
    await writeDescriptor(
      root,
      descriptor('owner-a', {
        control: { base_url: 'http://127.0.0.1:1', port: 1, token: 'test-token' },
      }),
    );

    expect((await stat(controlDir(root))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(controlDir(root))).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const parsed = await readDescriptors(root);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      protocol: 'agent-workers-control/1',
      owner_id: 'owner-a',
      pid: process.pid,
      version: VERSION,
      ready: true,
    });

    await removeDescriptor(root, 'owner-a');
    expect(await readDescriptors(root)).toEqual([]);
    await expect(removeDescriptor(root, 'owner-a')).resolves.toBeUndefined();
  });

  it('rejects descriptors with group or other permission bits', async () => {
    await writeDescriptor(root, descriptor('owner-a'));
    await chmod(join(controlDir(root), 'owner-a.json'), 0o640);
    expect(await readDescriptors(root)).toEqual([]);
  });

  it('rejects an owner_id that does not match the file name', async () => {
    const dir = controlDir(root);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'owner-a.json'), JSON.stringify(descriptor('owner-b')), {
      mode: 0o600,
    });
    expect(await readDescriptors(root)).toEqual([]);
  });

  it('rejects symlinks and unknown protocols', async () => {
    const dir = controlDir(root);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(root, 'real.json');
    await writeFile(target, JSON.stringify(descriptor('owner-link')), { mode: 0o600 });
    await symlink(target, join(dir, 'owner-link.json'));
    await writeFile(
      join(dir, 'owner-protocol.json'),
      JSON.stringify({ ...descriptor('owner-protocol'), protocol: 'other/1' }),
      { mode: 0o600 },
    );
    expect(await readDescriptors(root)).toEqual([]);
  });

  it('treats a dead pid as not live and prunes its descriptor', async () => {
    const dead = descriptor('owner-dead', { pid: await exitedPid() });
    await writeDescriptor(root, dead);
    await writeDescriptor(root, descriptor('owner-live'));

    expect(await isOwnerLive(dead)).toBe(false);
    await pruneStaleDescriptors(root);

    const names = await readdir(controlDir(root));
    expect(names).toContain('owner-live.json');
    expect(names).not.toContain('owner-dead.json');
  });

  it('reports live owners while excluding self', async () => {
    const pidStart = await readStartTime(process.pid);
    await writeDescriptor(root, descriptor('owner-self', { pid_start: pidStart }));
    await writeDescriptor(root, descriptor('owner-other', { pid_start: pidStart }));
    expect(await liveOwnerIds(root, 'owner-self')).toEqual(new Set(['owner-other']));
  });

  it('handles a missing control directory without throwing', async () => {
    const missing = join(root, 'missing');
    await expect(readDescriptors(missing)).resolves.toEqual([]);
    await expect(liveOwnerIds(missing, 'owner-self')).resolves.toEqual(new Set());
    await expect(pruneStaleDescriptors(missing)).resolves.toBeUndefined();
  });
});

const fakeDsh = `#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
if (process.argv.includes('--help') || process.argv.includes('--version')) {
  process.stdout.write('fake dsh 0.0.0\\n');
  process.exit(0);
}
const emit = (value) => console.log(JSON.stringify(value));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  emit({ type: 'session', sessionId: 'session-' + process.pid, cwd: process.cwd() });
  await delay(prompt.includes('HANG') ? 20000 : 100);
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  emit({ type: 'final', text: 'OK ' + prompt.trim() });
});
`;

interface StoredJobOptions {
  status: string;
  finishedAt?: string;
  ownerId?: string;
  sessionId?: string;
  sessionDir?: string;
  worktree?: {
    path: string;
    branch?: string;
    baseCommit?: string;
    repoRoot?: string;
    cleaned?: boolean;
  };
}

describe('owner leases and busy guards', () => {
  let root: string;
  let repo: string;
  let fake: string;
  let dshHome: string;
  const managers = new Set<JobManager>();
  let sequence = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-owner-test-'));
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
    fake = join(root, 'fake-dsh.mjs');
    await writeFile(fake, fakeDsh, { mode: 0o700 });
    await chmod(fake, 0o700);
    dshHome = join(root, 'dsh-home');
    const profileDir = join(dshHome, 'profiles', 'work-openrouter');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'metadata.json'),
      JSON.stringify({ provider: 'openrouter', model: 'test-model' }),
    );
  });

  afterAll(async () => {
    for (const manager of managers) {
      try {
        await manager.shutdown();
      } catch {
        // Keep tearing down the remaining managers.
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  function newStateDir(name: string): string {
    sequence += 1;
    return join(root, `${name}-${sequence}`, 'state');
  }

  async function configFor(stateDir: string): Promise<Config> {
    const worktreeRoot = join(stateDir, 'worktrees');
    await mkdir(stateDir, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    return {
      dshBin: fake,
      allowedRoots: [repo],
      stateDir,
      worktreeRoot,
      dshHome,
      maxConcurrent: 2,
      maxQueue: 8,
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      maxDepth: 2,
      retentionDays: 7,
      useDshCredentials: false,
      credentialsFile: join(root, 'credentials.yaml'),
      envAllow: ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'],
      stallMs: 120_000,
      loopRepeat: 4,
      toolErrorLimit: 5,
      watchdogAction: 'warn',
    };
  }

  async function startManager(stateDir: string): Promise<JobManager> {
    const manager = new JobManager(await configFor(stateDir));
    managers.add(manager);
    await manager.init();
    return manager;
  }

  async function readJob(
    stateDir: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(stateDir, 'jobs', id, 'job.json'), 'utf8'),
      ) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function waitForJob(
    stateDir: string,
    id: string,
    predicate: (job: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const saved = await readJob(stateDir, id);
      if (saved && predicate(saved)) return saved;
      await delay(50);
    }
    throw new Error(`timed out waiting for job ${id}`);
  }

  async function waitForSession(manager: JobManager, id: string): Promise<string> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const status = await manager.statusOutput([id]);
      const sessionId = status.jobs[0]?.session_id;
      if (sessionId) return sessionId;
      await delay(50);
    }
    throw new Error(`timed out waiting for the session of ${id}`);
  }

  async function writeStoredJob(
    stateDir: string,
    id: string,
    options: StoredJobOptions,
  ): Promise<void> {
    const dir = join(stateDir, 'jobs', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const createdAt = options.finishedAt ?? new Date().toISOString();
    await writeFile(
      join(dir, 'job.json'),
      JSON.stringify({
        schemaVersion: 1,
        id,
        backend: 'dsh',
        groupId: 'g_test',
        groupName: 'Test group',
        ownerId: options.ownerId ?? 'owner-dead',
        cwd: repo,
        profile: 'work-openrouter',
        access: 'read-only',
        isolation: 'none',
        timeoutMs: 60_000,
        status: options.status,
        createdAt,
        finishedAt: options.finishedAt,
        stderrTail: '',
        malformedLines: 0,
        eventsCount: 0,
        toolCalls: 0,
        steps: 0,
        sessionId: options.sessionId,
        sessionDir: options.sessionDir,
        worktree: options.worktree,
        eventsPath: join(dir, 'events.ndjson'),
        finalPath: join(dir, 'final.md'),
        stderrPath: join(dir, 'stderr.log'),
        jobPath: join(dir, 'job.json'),
      }),
      { mode: 0o600 },
    );
  }

  it('keeps a live foreign worker running, unlisted, and removes its descriptor', async () => {
    const stateDir = newStateDir('two-managers');
    const first = await startManager(stateDir);
    const started = await first.start({ task: 'HANG', access: 'read-only' });
    const running = await waitForJob(
      stateDir,
      started.job_id,
      (job) => job.status === 'running' && typeof job.pid === 'number',
    );
    const pid = running.pid as number;
    expect(() => process.kill(pid, 0)).not.toThrow();

    const second = await startManager(stateDir);
    expect((await second.statusOutput()).jobs.map((job) => job.job_id)).not.toContain(
      started.job_id,
    );

    const afterStartup = await readJob(stateDir, started.job_id);
    expect(afterStartup?.status).toBe('running');
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect((await readdir(controlDir(stateDir))).includes(`${first.owner}.json`)).toBe(true);

    await first.shutdown();
    expect((await readdir(controlDir(stateDir))).includes(`${first.owner}.json`)).toBe(false);
    await second.shutdown();
  });

  it('refuses cleanup and delete when foreign active jobs share resources', async () => {
    const stateDir = newStateDir('busy-disk');
    const sharedWorktree = join(stateDir, 'shared-worktree');
    const sharedSession = join(stateDir, 'shared-session');
    const now = new Date().toISOString();
    await writeStoredJob(stateDir, 'j_active', {
      status: 'running',
      ownerId: 'owner-live',
      sessionId: 'sid-1',
      sessionDir: sharedSession,
      worktree: { path: sharedWorktree, branch: 'b', baseCommit: 'c', repoRoot: repo },
    });
    await writeStoredJob(stateDir, 'j_done', {
      status: 'succeeded',
      finishedAt: now,
      sessionId: 'sid-1',
      sessionDir: sharedSession,
      worktree: { path: sharedWorktree, branch: 'b', baseCommit: 'c', repoRoot: repo },
    });
    await writeStoredJob(stateDir, 'j_session', {
      status: 'succeeded',
      finishedAt: now,
      sessionId: 'sid-1',
      sessionDir: sharedSession,
    });
    await writeStoredJob(stateDir, 'j_free', { status: 'succeeded', finishedAt: now });
    await writeDescriptor(
      stateDir,
      descriptor('owner-live', {
        pid: process.pid,
        pid_start: await readStartTime(process.pid),
      }),
    );

    const manager = await startManager(stateDir);
    expect((await manager.statusOutput()).jobs.map((job) => job.job_id)).not.toContain('j_active');
    expect(await manager.controlFacts('j_done')).toMatchObject({
      owner_id: 'owner-dead',
      owned: false,
      worktree_busy: true,
      session_busy: true,
      supports_resume: true,
      cleaned: false,
    });

    await expect(manager.cleanup('j_done', false)).rejects.toMatchObject({
      code: 'worktree_busy',
    });
    await expect(manager.delete('j_done', false)).rejects.toMatchObject({
      code: 'worktree_busy',
    });
    await expect(manager.delete('j_session', false)).rejects.toMatchObject({
      code: 'session_busy',
    });
    expect(await manager.cleanup('j_session', false)).toEqual({
      job_id: 'j_session',
      worktree: 'none',
      branch_deleted: false,
    });
    expect(await manager.delete('j_free', false)).toMatchObject({
      job_id: 'j_free',
      deleted: true,
    });
  });

  it('refuses delete when an in-memory active job still uses the session', async () => {
    const stateDir = newStateDir('busy-memory-session');
    const manager = await startManager(stateDir);
    const original = await manager.start({ task: 'HANG', access: 'read-only' });
    await waitForSession(manager, original.job_id);

    const steered = await manager.steer({ job_id: original.job_id, message: 'continue' });
    const steeredId = steered.steered_job_id as string;
    await waitForJob(stateDir, steeredId, (job) => job.status === 'running');

    expect(await manager.controlFacts(original.job_id)).toMatchObject({
      owner_id: manager.owner,
      owned: true,
      worktree_busy: false,
      session_busy: true,
      supports_resume: true,
      cleaned: false,
    });
    await expect(manager.delete(original.job_id, false)).rejects.toMatchObject({
      code: 'session_busy',
    });
    expect((await manager.cleanup(original.job_id, false)).worktree).toBe('none');

    await manager.cancel(steeredId);
    expect(await manager.delete(original.job_id, false)).toMatchObject({
      job_id: original.job_id,
      deleted: true,
    });
  });

  it('refuses cleanup and delete when an in-memory active job shares the worktree', async () => {
    const stateDir = newStateDir('busy-memory-worktree');
    const manager = await startManager(stateDir);
    const original = await manager.start({
      task: 'HANG',
      access: 'workspace-write',
      isolation: 'worktree',
    });
    expect(original.worktree).not.toBeNull();
    await waitForSession(manager, original.job_id);

    const steered = await manager.steer({ job_id: original.job_id, message: 'continue' });
    const steeredId = steered.steered_job_id as string;
    await waitForJob(stateDir, steeredId, (job) => job.status === 'running');

    await expect(manager.cleanup(original.job_id, false)).rejects.toMatchObject({
      code: 'worktree_busy',
    });
    await expect(manager.delete(original.job_id, false)).rejects.toMatchObject({
      code: 'worktree_busy',
    });

    await manager.cancel(steeredId);
    expect((await manager.cleanup(original.job_id, false)).worktree).toBe('removed');
    expect(await manager.delete(original.job_id, false)).toMatchObject({
      job_id: original.job_id,
      deleted: true,
    });
  });

  it('retention skips busy expired jobs and reports them', async () => {
    const stateDir = newStateDir('prune');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const sharedWorktree = join(stateDir, 'shared-worktree');
    const sharedSession = join(stateDir, 'shared-session');
    await writeStoredJob(stateDir, 'j_old_worktree', {
      status: 'succeeded',
      finishedAt: old,
      worktree: { path: sharedWorktree },
    });
    await writeStoredJob(stateDir, 'j_old_session', {
      status: 'succeeded',
      finishedAt: old,
      sessionId: 'sid-1',
      sessionDir: sharedSession,
    });
    await writeStoredJob(stateDir, 'j_old_free', { status: 'succeeded', finishedAt: old });
    await writeStoredJob(stateDir, 'j_active', {
      status: 'running',
      worktree: { path: sharedWorktree },
      sessionId: 'sid-1',
      sessionDir: sharedSession,
    });

    const result = await pruneExpiredJobs(stateDir, 7);
    expect(result.skipped_busy.sort()).toEqual(['j_old_session', 'j_old_worktree']);
    expect(result.deleted).toEqual(['j_old_free']);
    expect(await exists(join(stateDir, 'jobs', 'j_old_worktree'))).toBe(true);
    expect(await exists(join(stateDir, 'jobs', 'j_old_session'))).toBe(true);
    expect(await exists(join(stateDir, 'jobs', 'j_old_free'))).toBe(false);
  });

  it('retention keeps expired jobs owned by a live foreign manager', async () => {
    const stateDir = newStateDir('prune-live-owner');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeStoredJob(stateDir, 'j_old_live', {
      status: 'succeeded',
      finishedAt: old,
      ownerId: 'owner-live',
    });
    await writeDescriptor(stateDir, descriptor('owner-live'));

    const result = await pruneExpiredJobs(stateDir, 7);
    expect(result.deleted).toEqual([]);
    expect(await exists(join(stateDir, 'jobs', 'j_old_live'))).toBe(true);
  });
});
