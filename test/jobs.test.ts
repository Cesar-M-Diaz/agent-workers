import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  console.log(JSON.stringify({ type: 'session', sessionId: 'session-' + process.pid, cwd: process.cwd() }));
  if (prompt.includes('HANG')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('WRITE')) {
    await writeFile('worker-output.txt', 'from worker\\n');
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log(JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }));
  console.log(JSON.stringify({ type: 'final', text: 'OK ' + prompt.trim() }));
});
`;

describe('JobManager', () => {
  let root: string;
  let repo: string;
  let manager: JobManager;
  let config: Config;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workers-test-'));
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
      maxConcurrent: 1,
      maxQueue: 4,
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      maxDepth: 2,
      retentionDays: 7,
      useDshCredentials: false,
      credentialsFile: join(root, 'credentials.yaml'),
      envAllow: ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'],
    };
    await mkdir(config.stateDir);
    await mkdir(config.worktreeRoot);
    await mkdir(config.dshHome);
    manager = new JobManager(config);
    await manager.init();
  });

  afterAll(async () => {
    await manager.shutdown();
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
});
