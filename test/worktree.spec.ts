import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCapture } from '../src/proc.js';
import { cleanupWorktree, createWorktree } from '../src/worktree.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('cleanupWorktree', () => {
  let root: string;
  let repo: string;
  let worktreeRoot: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-worktree-test-'));
    repo = join(root, 'repo');
    worktreeRoot = join(root, 'worktrees');
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
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves and then removes a clean worktree with commits ahead of base', async () => {
    const info = await createWorktree({ cwd: repo, jobId: 'j_commits', worktreeRoot });
    await writeFile(join(info.path, 'change.txt'), 'change\n');
    await runCapture('git', [
      '-C',
      info.path,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'add',
      '.',
    ]);
    await runCapture('git', [
      '-C',
      info.path,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-qm',
      'change',
    ]);

    const preserved = await cleanupWorktree(info, false, worktreeRoot);
    expect(preserved).toEqual({ worktree: 'preserved_dirty', branchDeleted: false });
    expect(await exists(info.path)).toBe(true);

    const removed = await cleanupWorktree(info, true, worktreeRoot);
    expect(removed.worktree).toBe('removed');
    expect(removed.branchDeleted).toBe(true);
    expect(await exists(info.path)).toBe(false);
  });

  it('falls back safely when git metadata is materialized as a directory', async () => {
    const info = await createWorktree({ cwd: repo, jobId: 'j_broken', worktreeRoot });
    const gitFile = join(info.path, '.git');
    await rm(gitFile);
    await mkdir(gitFile);

    const removed = await cleanupWorktree(info, true, worktreeRoot);
    expect(removed.worktree).toBe('removed');
    expect(removed.branchDeleted).toBe(true);
    expect(await exists(info.path)).toBe(false);
    const branch = await runCapture('git', [
      '-C',
      repo,
      'rev-parse',
      '--verify',
      `refs/heads/${info.branch}`,
    ]);
    expect(branch.code).not.toBe(0);
  });
});
