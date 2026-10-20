import type { Dirent } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorktreeInfo } from './types.js';
import { cleanupWorktree } from './worktree.js';

const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running']);

export interface AdminJobFile {
  id?: string;
  status?: string;
  finishedAt?: string;
  worktree?: {
    path?: string;
    branch?: string;
    baseCommit?: string;
    repoRoot?: string;
    cleaned?: boolean;
  };
}

export interface DeleteJobResult {
  job_id: string;
  deleted: true;
  worktree: 'removed' | 'none';
  branch_deleted: boolean;
}

export class JobAdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'JobAdminError';
  }
}

function jobDir(stateDir: string, jobId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new JobAdminError('invalid_job_id', 'invalid job id', 400);
  }
  return join(stateDir, 'jobs', jobId);
}

async function readAdminJob(stateDir: string, jobId: string): Promise<AdminJobFile> {
  try {
    return JSON.parse(
      await readFile(join(jobDir(stateDir, jobId), 'job.json'), 'utf8'),
    ) as AdminJobFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JobAdminError('job_not_found', `unknown job ${jobId}`, 404);
    }
    throw new JobAdminError('job_unreadable', `cannot read job ${jobId}`, 500);
  }
}

function restoreWorktree(saved: AdminJobFile): WorktreeInfo | undefined {
  const value = saved.worktree;
  if (
    !value ||
    typeof value.path !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.baseCommit !== 'string' ||
    typeof value.repoRoot !== 'string'
  ) {
    return undefined;
  }
  return {
    path: value.path,
    branch: value.branch,
    baseCommit: value.baseCommit,
    repoRoot: value.repoRoot,
  };
}

export async function deleteJobRecord(
  stateDir: string,
  jobId: string,
  options: { discardChanges?: boolean } = {},
): Promise<DeleteJobResult> {
  const saved = await readAdminJob(stateDir, jobId);
  const status = typeof saved.status === 'string' ? saved.status : 'unknown';
  if (ACTIVE_STATUSES.has(status)) {
    throw new JobAdminError('job_active', 'cannot delete an active job', 409, {
      status,
    });
  }

  let worktree: 'removed' | 'none' = 'none';
  let branchDeleted = false;
  const info = restoreWorktree(saved);
  if (info && saved.worktree?.cleaned !== true) {
    let cleaned: Awaited<ReturnType<typeof cleanupWorktree>>;
    try {
      cleaned = await cleanupWorktree(info, options.discardChanges === true);
    } catch (err) {
      throw new JobAdminError(
        'worktree_error',
        err instanceof Error ? err.message : String(err),
        500,
      );
    }
    if (cleaned.worktree === 'preserved_dirty') {
      throw new JobAdminError(
        'worktree_dirty',
        'worktree has uncommitted changes; confirm discarding them to delete the job',
        409,
        { worktree: 'preserved_dirty' },
      );
    }
    worktree = cleaned.worktree;
    branchDeleted = cleaned.branchDeleted;
  }

  await rm(jobDir(stateDir, jobId), { recursive: true, force: true });
  return { job_id: jobId, deleted: true, worktree, branch_deleted: branchDeleted };
}

export interface PruneResult {
  deleted: string[];
  preserved_dirty: string[];
  errors: Array<{ job_id: string; message: string }>;
}

/** Delete terminal jobs older than the retention window. Dirty worktrees are kept. */
export async function pruneExpiredJobs(
  stateDir: string,
  retentionDays: number,
): Promise<PruneResult> {
  const result: PruneResult = { deleted: [], preserved_dirty: [], errors: [] };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return result;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let entries: Dirent[];
  try {
    entries = await readdir(join(stateDir, 'jobs'), { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    let saved: AdminJobFile;
    try {
      saved = JSON.parse(
        await readFile(join(stateDir, 'jobs', entry.name, 'job.json'), 'utf8'),
      ) as AdminJobFile;
    } catch {
      continue;
    }
    const status = typeof saved.status === 'string' ? saved.status : 'unknown';
    if (ACTIVE_STATUSES.has(status)) continue;
    const finished = saved.finishedAt === undefined ? Number.NaN : Date.parse(saved.finishedAt);
    if (!Number.isFinite(finished) || finished > cutoff) continue;

    try {
      await deleteJobRecord(stateDir, entry.name, { discardChanges: false });
      result.deleted.push(entry.name);
    } catch (err) {
      if (err instanceof JobAdminError && err.code === 'worktree_dirty') {
        result.preserved_dirty.push(entry.name);
      } else {
        result.errors.push({
          job_id: entry.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}
