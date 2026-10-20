import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runCapture } from './proc.js';
import type { ChangedFile, WorktreeChanges, WorktreeInfo } from './types.js';

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const MAX_DIFF_BYTES = 200 * 1024;

function gitError(action: string, result: { code: number | null; stderr: string }): Error {
  return new Error(
    `${action}: ${result.stderr.trim() || `git exited ${result.code ?? 'unknown'}`}`,
  );
}

export async function repoRoot(cwd: string): Promise<string> {
  const result = await runCapture('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (result.code !== 0) throw gitError('cwd is not inside a git repository', result);
  return result.stdout.trim();
}

export async function resolveBaseCommit(
  repo: string,
  baseRef: string | undefined,
): Promise<string> {
  const ref = baseRef ?? 'HEAD';
  if (!SAFE_REF.test(ref) || ref.startsWith('-')) throw new Error('base_ref is not a safe git ref');
  const result = await runCapture('git', [
    '-C',
    repo,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  if (result.code !== 0) throw gitError('base_ref does not resolve to a commit', result);
  return result.stdout.trim();
}

export async function createWorktree(input: {
  cwd: string;
  jobId: string;
  baseRef?: string;
  worktreeRoot: string;
}): Promise<WorktreeInfo> {
  const repo = await repoRoot(input.cwd);
  const baseCommit = await resolveBaseCommit(repo, input.baseRef);
  const path = join(input.worktreeRoot, input.jobId);
  const branch = `dsh/${input.jobId}`;
  await mkdir(input.worktreeRoot, { recursive: true, mode: 0o700 });
  try {
    await stat(path);
    throw new Error(`worktree path already exists: ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const result = await runCapture('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '--quiet',
    '-b',
    branch,
    path,
    baseCommit,
  ]);
  if (result.code !== 0) throw gitError('cannot create git worktree', result);
  return { path, branch, baseCommit, repoRoot: repo };
}

function parseNumstat(text: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const path = parts.slice(2).join('\t');
    const additions = Number(parts[0]);
    const deletions = Number(parts[1]);
    if (Number.isFinite(additions) && Number.isFinite(deletions)) {
      map.set(path, { additions, deletions });
    }
  }
  return map;
}

function parseNameStatus(
  text: string,
  numstat: Map<string, { additions: number; deletions: number }>,
): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0]!;
    const path = parts[parts.length - 1]!;
    const counts = numstat.get(path);
    files.push({
      path,
      status,
      ...(counts ? { additions: counts.additions, deletions: counts.deletions } : {}),
    });
  }
  return files;
}

export async function computeWorktreeChanges(info: WorktreeInfo): Promise<WorktreeChanges> {
  // Intent-to-add makes untracked files visible to `git diff` without staging content.
  const add = await runCapture('git', ['-C', info.path, 'add', '-N', '--', '.']);
  if (add.code !== 0) throw gitError('cannot record untracked files for diff', add);

  const [diffStat, nameStatus, numstat, diff] = await Promise.all([
    runCapture('git', ['-C', info.path, 'diff', '--no-ext-diff', '--stat', info.baseCommit, '--']),
    runCapture('git', [
      '-C',
      info.path,
      'diff',
      '--no-ext-diff',
      '--name-status',
      info.baseCommit,
      '--',
    ]),
    runCapture('git', [
      '-C',
      info.path,
      'diff',
      '--no-ext-diff',
      '--numstat',
      info.baseCommit,
      '--',
    ]),
    runCapture('git', ['-C', info.path, 'diff', '--no-ext-diff', info.baseCommit, '--']),
  ]);
  for (const result of [diffStat, nameStatus, numstat, diff]) {
    if (result.code !== 0) throw gitError('cannot inspect worktree changes', result);
  }
  const full = diff.stdout;
  return {
    baseCommit: info.baseCommit,
    files: parseNameStatus(nameStatus.stdout, parseNumstat(numstat.stdout)),
    diffStat: diffStat.stdout.trim(),
    diff: full.length > MAX_DIFF_BYTES ? full.slice(0, MAX_DIFF_BYTES) : full,
    diffTruncated: full.length > MAX_DIFF_BYTES,
  };
}

function assertInsideWorktreeRoot(path: string, worktreeRoot: string): void {
  const rel = relative(resolve(worktreeRoot), resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to remove worktree outside ${worktreeRoot}: ${path}`);
  }
}

async function worktreeHasChanges(info: WorktreeInfo): Promise<boolean> {
  const status = await runCapture('git', [
    '-C',
    info.path,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (status.code !== 0) return true;
  if (status.stdout.trim() !== '') return true;

  const ahead = await runCapture('git', [
    '-C',
    info.path,
    'rev-list',
    '--count',
    `${info.baseCommit}..HEAD`,
  ]);
  if (ahead.code !== 0) return true;
  const count = Number(ahead.stdout.trim());
  return !Number.isInteger(count) || count > 0;
}

function isBrokenWorktreeMetadata(stderr: string): boolean {
  return /is not a \.git file|cannot remove working tree|validation failed/i.test(stderr);
}

export async function cleanupWorktree(
  info: WorktreeInfo,
  discardChanges: boolean,
  worktreeRoot: string,
): Promise<{ worktree: 'removed' | 'preserved_dirty' | 'none'; branchDeleted: boolean }> {
  assertInsideWorktreeRoot(info.path, worktreeRoot);
  try {
    const infoStat = await stat(info.path);
    if (!infoStat.isDirectory()) return { worktree: 'none', branchDeleted: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { worktree: 'none', branchDeleted: false };
    throw err;
  }

  if (!discardChanges && (await worktreeHasChanges(info))) {
    return { worktree: 'preserved_dirty', branchDeleted: false };
  }

  const remove = await runCapture('git', [
    '-C',
    info.repoRoot,
    'worktree',
    'remove',
    ...(discardChanges ? ['--force'] : []),
    info.path,
  ]);
  if (remove.code !== 0) {
    // Some tools materialize the linked worktree's `.git` file as a directory.
    // Git then refuses `worktree remove`; after the dirty check above, remove
    // the isolated directory and prune the now-stale registration instead.
    if (!isBrokenWorktreeMetadata(remove.stderr))
      throw gitError('cannot remove git worktree', remove);
    await rm(info.path, { recursive: true, force: true });
    await runCapture('git', ['-C', info.repoRoot, 'worktree', 'prune', '--expire', 'now']);
  }

  const branch = await runCapture('git', ['-C', info.repoRoot, 'branch', '-D', info.branch]);
  return { worktree: 'removed', branchDeleted: branch.code === 0 };
}
