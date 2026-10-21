import type { Dirent } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { liveOwnerIds } from './control/descriptor.js';
import type { WorktreeInfo } from './types.js';
import { cleanupWorktree } from './worktree.js';

const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running']);

export interface AdminJobFile {
  id?: string;
  status?: string;
  finishedAt?: string;
  ownerId?: string;
  sessionId?: string;
  sessionDir?: string;
  worktree?: {
    path?: string;
    branch?: string;
    baseCommit?: string;
    repoRoot?: string;
    cleaned?: boolean;
  };
}

export interface StoredJob {
  id: string;
  job: AdminJobFile;
}

export type BusyKind = 'worktree_busy' | 'session_busy';

export interface JobResources {
  id: string;
  status?: string;
  worktreePath?: string;
  sessionId?: string;
  sessionDir?: string;
}

export function resourcesOf(id: string, job: AdminJobFile): JobResources {
  return {
    id,
    status: job.status,
    worktreePath: job.worktree?.path,
    sessionId: job.sessionId,
    sessionDir: job.sessionDir,
  };
}

export function isActiveStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_STATUSES.has(status);
}

/** Resources shared by two jobs; a worktree match wins over a session match. */
export function busyKinds(target: JobResources, other: JobResources): BusyKind[] {
  const kinds: BusyKind[] = [];
  if (target.worktreePath && target.worktreePath === other.worktreePath) {
    kinds.push('worktree_busy');
  }
  const sameSessionDir = target.sessionDir !== undefined && target.sessionDir === other.sessionDir;
  const sameSessionId = target.sessionId !== undefined && target.sessionId === other.sessionId;
  if (sameSessionDir || sameSessionId) kinds.push('session_busy');
  return kinds;
}

/** Read every parseable job.json, so busy checks also see foreign owners. */
export async function readStoredJobs(stateDir: string): Promise<StoredJob[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(stateDir, 'jobs'), { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs: StoredJob[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    try {
      const job = JSON.parse(
        await readFile(join(stateDir, 'jobs', entry.name, 'job.json'), 'utf8'),
      ) as unknown;
      if (typeof job !== 'object' || job === null) continue;
      jobs.push({ id: entry.name, job: job as AdminJobFile });
    } catch {
      // A torn or old job file must not stop the caller.
    }
  }
  return jobs;
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
  options: { discardChanges?: boolean; worktreeRoot?: string } = {},
): Promise<DeleteJobResult> {
  const worktreeRoot = options.worktreeRoot ?? join(stateDir, 'worktrees');
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
      cleaned = await cleanupWorktree(info, options.discardChanges === true, worktreeRoot);
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
        'worktree has uncommitted changes or commits not in the base revision; confirm discarding them to delete the job',
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
  skipped_busy: string[];
  errors: Array<{ job_id: string; message: string }>;
}

/**
 * Delete terminal jobs older than the retention window. Jobs owned by another
 * live manager, and jobs still sharing a worktree or session with an active
 * job, are left alone.
 */
export async function pruneExpiredJobs(
  stateDir: string,
  retentionDays: number,
  worktreeRoot = join(stateDir, 'worktrees'),
  selfOwnerId?: string,
): Promise<PruneResult> {
  const result: PruneResult = {
    deleted: [],
    preserved_dirty: [],
    skipped_busy: [],
    errors: [],
  };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return result;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const stored = await readStoredJobs(stateDir);
  const liveOwners = await liveOwnerIds(stateDir, selfOwnerId ?? '');
  const active = stored
    .filter((entry) => isActiveStatus(entry.job.status))
    .map((entry) => resourcesOf(entry.id, entry.job));

  for (const entry of stored) {
    const saved = entry.job;
    const status = typeof saved.status === 'string' ? saved.status : 'unknown';
    if (ACTIVE_STATUSES.has(status)) continue;
    const finished = saved.finishedAt === undefined ? Number.NaN : Date.parse(saved.finishedAt);
    if (!Number.isFinite(finished) || finished > cutoff) continue;

    const candidate = resourcesOf(entry.id, saved);
    const busy = active.some(
      (other) => other.id !== candidate.id && busyKinds(candidate, other).length > 0,
    );
    if (busy) {
      result.skipped_busy.push(entry.id);
      continue;
    }
    if (typeof saved.ownerId === 'string' && liveOwners.has(saved.ownerId)) continue;

    try {
      await deleteJobRecord(stateDir, entry.id, { discardChanges: false, worktreeRoot });
      result.deleted.push(entry.id);
    } catch (err) {
      if (err instanceof JobAdminError && err.code === 'worktree_dirty') {
        result.preserved_dirty.push(entry.id);
      } else {
        result.errors.push({
          job_id: entry.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}
