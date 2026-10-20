import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type Dirent, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { resolveApiKey } from './config.js';
import { NdjsonFold } from './ndjson.js';
import { pathOverlaps, resolveAllowedPath } from './paths.js';
import {
  killTree,
  killTreeByPid,
  readStartTime,
  runCapture,
  spawnDsh,
  waitForExit,
} from './proc.js';
import type {
  AccessMode,
  FailureReason,
  Isolation,
  JobStatus,
  JobSummary,
  StartInput,
  StartResult,
  StatusOutput,
  Usage,
  WaitOutput,
  WorktreeChanges,
  WorktreeInfo,
} from './types.js';
import { cleanupWorktree, computeWorktreeChanges, createWorktree } from './worktree.js';

const MAX_STDERR = 64 * 1024;

export class JobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

interface Job {
  id: string;
  label?: string;
  task: string;
  cwd: string;
  access: AccessMode;
  isolation: Isolation;
  timeoutMs: number;
  status: JobStatus;
  reason?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  pgidStartTime?: string;
  sessionId?: string;
  resumeOf?: string;
  worktree?: WorktreeInfo;
  finalText?: string;
  stderrTail: string;
  errorMessage?: string;
  fold: NdjsonFold;
  child?: ChildProcessWithoutNullStreams;
  eventStream?: WriteStream;
  timeoutTimer?: NodeJS.Timeout;
  cancelReason?: 'cancelled' | 'timed_out';
  terminal: boolean;
  killedPids?: number[];
  survivors?: number[];
  changes?: WorktreeChanges;
  cleaned?: boolean;
  eventsPath: string;
  finalPath: string;
  stderrPath: string;
  jobPath: string;
  dir: string;
}

interface PersistedJob {
  id: string;
  label?: string;
  cwd: string;
  access: AccessMode;
  isolation: Isolation;
  timeoutMs: number;
  status: JobStatus;
  reason?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  pgidStartTime?: string;
  sessionId?: string;
  resumeOf?: string;
  worktree?: WorktreeInfo;
  stderrTail: string;
  errorMessage?: string;
  malformedLines: number;
  eventsCount: number;
  toolCalls: number;
  steps: number;
  lastTool?: string;
  turnEndKind?: string;
  usage?: Usage;
  killedPids?: number[];
  survivors?: number[];
  cleaned?: boolean;
  eventsPath: string;
  finalPath: string;
  stderrPath: string;
  jobPath: string;
}

function appendTail(current: string, chunk: string, maxBytes = MAX_STDERR): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  let start = combined.length;
  while (start > 0 && Buffer.byteLength(combined.slice(start), 'utf8') <= maxBytes) start -= 1;
  return combined.slice(start + 1);
}

function persisted(job: Job): PersistedJob {
  return {
    id: job.id,
    label: job.label,
    cwd: job.cwd,
    access: job.access,
    isolation: job.isolation,
    timeoutMs: job.timeoutMs,
    status: job.status,
    reason: job.reason,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    pid: job.pid,
    pgidStartTime: job.pgidStartTime,
    sessionId: job.sessionId ?? job.fold.state.sessionId,
    resumeOf: job.resumeOf,
    worktree: job.worktree,
    stderrTail: job.stderrTail,
    errorMessage: job.errorMessage ?? job.fold.state.errorMessage,
    malformedLines: job.fold.state.malformedLines,
    eventsCount: job.fold.state.eventsCount,
    toolCalls: job.fold.state.toolCalls,
    steps: job.fold.state.steps,
    lastTool: job.fold.state.lastTool,
    turnEndKind: job.fold.state.turnEndKind,
    usage: job.fold.state.usage,
    killedPids: job.killedPids,
    survivors: job.survivors,
    cleaned: job.cleaned,
    eventsPath: job.eventsPath,
    finalPath: job.finalPath,
    stderrPath: job.stderrPath,
    jobPath: job.jobPath,
  };
}

function fromPersisted(saved: PersistedJob): Job {
  const fold = new NdjsonFold();
  fold.state.sessionId = saved.sessionId;
  fold.state.malformedLines = saved.malformedLines;
  fold.state.eventsCount = saved.eventsCount;
  fold.state.toolCalls = saved.toolCalls;
  fold.state.steps = saved.steps;
  fold.state.lastTool = saved.lastTool;
  fold.state.turnEndKind = saved.turnEndKind;
  fold.state.usage = saved.usage;
  return {
    id: saved.id,
    label: saved.label,
    task: '',
    cwd: saved.cwd,
    access: saved.access,
    isolation: saved.isolation,
    timeoutMs: saved.timeoutMs,
    status: saved.status,
    reason: saved.reason,
    createdAt: saved.createdAt,
    startedAt: saved.startedAt,
    finishedAt: saved.finishedAt,
    pid: saved.pid,
    pgidStartTime: saved.pgidStartTime,
    sessionId: saved.sessionId,
    resumeOf: saved.resumeOf,
    worktree: saved.worktree,
    stderrTail: saved.stderrTail,
    errorMessage: saved.errorMessage,
    fold,
    terminal: !['queued', 'starting', 'running'].includes(saved.status),
    killedPids: saved.killedPids,
    survivors: saved.survivors,
    cleaned: saved.cleaned,
    eventsPath: saved.eventsPath,
    finalPath: saved.finalPath,
    stderrPath: saved.stderrPath,
    jobPath: saved.jobPath,
    dir: join(saved.jobPath, '..'),
  };
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly running = new Set<string>();
  private readonly writeLocks = new Map<string, string>();
  private readonly sessionLocks = new Map<string, string>();
  private dispatchScheduled = false;
  private shuttingDown = false;
  private dshVersion = 'unavailable';
  private apiKey?: string;
  private readyPromise?: Promise<void>;

  constructor(private readonly config: Config) {}

  async init(): Promise<void> {
    await mkdir(join(this.config.stateDir, 'jobs'), { recursive: true, mode: 0o700 });
    this.apiKey = await resolveApiKey(this.config);
    const version = await runCapture(this.config.dshBin, ['--version'], { timeoutMs: 10_000 });
    this.dshVersion = version.code === 0 ? version.stdout.trim() : 'unavailable';
    await this.loadPreviousJobs();
  }

  private async loadPreviousJobs(): Promise<void> {
    const root = join(this.config.stateDir, 'jobs');
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobPath = join(root, entry.name, 'job.json');
      try {
        const saved = JSON.parse(await readFile(jobPath, 'utf8')) as PersistedJob;
        if (!saved?.id) continue;
        const job = fromPersisted(saved);
        if (!job.terminal) {
          if (job.pid !== undefined && job.pgidStartTime !== undefined) {
            const currentStart = await readStartTime(job.pid);
            if (currentStart !== undefined && currentStart === job.pgidStartTime) {
              const killed = await killTreeByPid(job.pid);
              job.killedPids = killed.pids;
              job.survivors = killed.survivors;
            }
          }
          job.status = 'interrupted';
          job.reason = 'interrupted';
          job.finishedAt = new Date().toISOString();
          job.terminal = true;
          await this.writeJob(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        // A torn or old job file must not keep the server down.
      }
    }
  }

  statusOutput(jobIds?: readonly string[]): StatusOutput {
    const jobs = this.selectJobs(jobIds).map((job) => this.summary(job));
    return {
      server: {
        dsh_version: this.dshVersion,
        max_concurrent: this.config.maxConcurrent,
        max_queue: this.config.maxQueue,
        running: this.running.size,
        queued: this.queue.length,
        state_dir: this.config.stateDir,
      },
      jobs,
    };
  }

  private async resolveCwd(input: string | undefined): Promise<string> {
    try {
      return await resolveAllowedPath(
        input ?? this.config.allowedRoots[0]!,
        this.config.allowedRoots,
        this.config.allowedRoots[0]!,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new JobError('cwd_outside_roots', message);
    }
  }

  async start(input: StartInput): Promise<StartResult> {
    if (this.shuttingDown)
      throw new JobError('dsh_unavailable', 'the worker manager is shutting down');
    const depth = Number(process.env.DSH_WORKERS_DEPTH ?? 0);
    if (!Number.isInteger(depth) || depth < 0) {
      throw new JobError('depth_exceeded', 'DSH_WORKERS_DEPTH is invalid');
    }
    if (depth >= this.config.maxDepth) {
      throw new JobError('depth_exceeded', `maximum worker depth ${this.config.maxDepth} reached`);
    }
    if (this.running.size + this.queue.length >= this.config.maxConcurrent + this.config.maxQueue) {
      throw new JobError('queue_full', `worker queue is full (${this.config.maxQueue})`);
    }

    const now = new Date().toISOString();
    const id = `j_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const timeoutMs = Math.min(
      this.config.maxTimeoutMs,
      Math.max(60_000, (input.timeout_s ?? Math.round(this.config.defaultTimeoutMs / 1000)) * 1000),
    );

    let cwd: string;
    let access: AccessMode;
    let isolation: Isolation;
    let worktree: WorktreeInfo | undefined;
    let sessionId: string | undefined;
    let resumeOf: string | undefined;

    if (input.resume_job_id) {
      if (
        input.cwd !== undefined ||
        input.isolation !== undefined ||
        input.base_ref !== undefined
      ) {
        throw new JobError(
          'resume_unavailable',
          'resume_job_id cannot be combined with cwd, isolation or base_ref',
        );
      }
      const original = this.jobs.get(input.resume_job_id);
      if (!original) throw new JobError('resume_unavailable', 'unknown job to resume');
      if (!original.terminal)
        throw new JobError('resume_unavailable', 'the original job is still active');
      if (!original.sessionId)
        throw new JobError('resume_unavailable', 'the original job has no session id');
      if (original.worktree) {
        if (original.cleaned)
          throw new JobError('resume_unavailable', 'the original worktree was cleaned');
        try {
          const info = await stat(original.worktree.path);
          if (!info.isDirectory()) throw new Error('not a directory');
        } catch {
          throw new JobError('resume_unavailable', 'the original worktree no longer exists');
        }
      }
      if (this.sessionLocks.has(original.sessionId)) {
        throw new JobError(
          'resume_unavailable',
          'the session is already being resumed by another worker',
        );
      }
      if (original.worktree) {
        cwd = original.worktree.path;
      } else {
        cwd = await this.resolveCwd(original.cwd);
      }
      access = original.access;
      isolation = original.isolation;
      worktree = original.worktree;
      sessionId = original.sessionId;
      resumeOf = original.id;
      if (access === 'workspace-write' && isolation === 'none') {
        const conflict = [...this.writeLocks.entries()].find(([, jobId]) => {
          const other = this.jobs.get(jobId);
          return other !== undefined && pathOverlaps(other.cwd, cwd);
        });
        if (conflict)
          throw new JobError('write_conflict', `another write worker owns ${conflict[0]}`);
        this.writeLocks.set(cwd, id);
      }
    } else {
      cwd = await this.resolveCwd(input.cwd);
      access = input.access ?? 'read-only';
      isolation = input.isolation ?? (access === 'workspace-write' ? 'worktree' : 'none');
      if (isolation === 'worktree') {
        try {
          worktree = await createWorktree({
            cwd,
            jobId: id,
            baseRef: input.base_ref,
            worktreeRoot: this.config.worktreeRoot,
          });
          cwd = worktree.path;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new JobError('worktree_error', message);
        }
      } else if (access === 'workspace-write') {
        const conflict = [...this.writeLocks.entries()].find(([, jobId]) => {
          const other = this.jobs.get(jobId);
          return other !== undefined && pathOverlaps(other.cwd, cwd);
        });
        if (conflict)
          throw new JobError('write_conflict', `another write worker owns ${conflict[0]}`);
        this.writeLocks.set(cwd, id);
      }
    }

    if (sessionId) this.sessionLocks.set(sessionId, id);

    const dir = join(this.config.stateDir, 'jobs', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const job: Job = {
      id,
      label: input.label,
      task: input.task,
      cwd,
      access,
      isolation,
      timeoutMs,
      status: 'queued',
      createdAt: now,
      sessionId,
      resumeOf,
      worktree,
      stderrTail: '',
      fold: new NdjsonFold(),
      terminal: false,
      eventsPath: join(dir, 'events.ndjson'),
      finalPath: join(dir, 'final.md'),
      stderrPath: join(dir, 'stderr.log'),
      jobPath: join(dir, 'job.json'),
      dir,
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    await this.writeJob(job);
    this.dispatch();
    const queuePosition = this.queue.indexOf(job) + 1;
    return {
      job_id: id,
      status: job.status,
      ...(job.status === 'queued' ? { queue_position: queuePosition } : {}),
      cwd: job.cwd,
      worktree: job.worktree
        ? {
            path: job.worktree.path,
            branch: job.worktree.branch,
            base_commit: job.worktree.baseCommit,
          }
        : null,
    };
  }

  private dispatch(): void {
    if (this.dispatchScheduled || this.shuttingDown) return;
    this.dispatchScheduled = true;
    queueMicrotask(() => {
      this.dispatchScheduled = false;
      while (
        !this.shuttingDown &&
        this.running.size < this.config.maxConcurrent &&
        this.queue.length > 0
      ) {
        const job = this.queue.shift();
        if (job?.status !== 'queued') continue;
        job.status = 'starting';
        this.running.add(job.id);
        void this.writeJob(job).catch(() => undefined);
        void this.launch(job).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          void this.settle(job, 'failed', 'spawn_error', {
            errorMessage: message,
            cleanTree: false,
          });
        });
      }
    });
  }

  private async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const env = this.childEnv(1);
        const result = await runCapture(this.config.dshBin, ['--profile', 'headless', '--help'], {
          cwd: this.config.allowedRoots[0],
          env,
          timeoutMs: 30_000,
        });
        if (result.code !== 0) {
          throw new JobError(
            'dsh_unavailable',
            `cannot initialize dsh headless profile: ${result.stderr.trim()}`,
          );
        }
      })();
    }
    return await this.readyPromise;
  }

  private childEnv(depth: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.config.envAllow) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    env.DSH_HOME = this.config.dshHome;
    env.DSH_PERMISSION_MODE = 'read-only';
    env.DSH_TELEMETRY_DISABLED = '1';
    env.DSH_WORKERS_DEPTH = String(depth);
    if (this.apiKey) env.DEEPSEEK_API_KEY = this.apiKey;
    return env;
  }

  private async launch(job: Job): Promise<void> {
    await this.ensureReady();
    const depth = Number(process.env.DSH_WORKERS_DEPTH ?? 0) + 1;
    const env = this.childEnv(depth);
    env.DSH_PERMISSION_MODE = job.access === 'workspace-write' ? 'workspace-write' : 'read-only';
    const args = ['--profile', 'headless', '--json'];
    if (job.sessionId) args.push('--session-id', job.sessionId);
    const child = spawnDsh({
      dshBin: this.config.dshBin,
      args,
      cwd: job.cwd,
      env,
    });
    if (!child.pid) throw new JobError('spawn_error', 'dsh did not produce a pid');
    job.child = child;
    job.pid = child.pid;
    job.pgidStartTime = await readStartTime(child.pid);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.eventStream = createWriteStream(job.eventsPath, { flags: 'a', mode: 0o600 });
    job.fold = new NdjsonFold((line) => job.eventStream?.write(`${line}\n`));
    child.stdout.on('data', (chunk: Buffer) => job.fold.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      job.stderrTail = appendTail(job.stderrTail, chunk.toString('utf8'));
    });
    child.once('error', (err) => {
      job.errorMessage = err.message;
    });
    child.once('close', (code, signal) => {
      void this.onClose(job, code, signal).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void this.settle(job, 'failed', 'driver_error', {
          errorMessage: message,
          cleanTree: false,
        });
      });
    });
    child.stdin.on('error', () => undefined);
    job.timeoutTimer = setTimeout(() => {
      void this.timeout(job).catch(() => undefined);
    }, job.timeoutMs);
    await this.writeJob(job);
    child.stdin.end(job.task);
  }

  private async onClose(
    job: Job,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (job.eventStream) {
      job.eventStream.end();
      job.eventStream = undefined;
    }
    const fold = job.fold.end();
    job.sessionId = job.sessionId ?? fold.sessionId;
    if (job.timeoutTimer) {
      clearTimeout(job.timeoutTimer);
      job.timeoutTimer = undefined;
    }
    if (fold.finalText !== undefined) {
      job.finalText = fold.finalText;
      try {
        await writeFile(job.finalPath, fold.finalText, { mode: 0o600 });
      } catch {
        // The result tool reports a missing final file instead of crashing the server.
      }
    }
    if (job.child?.pid) {
      const killed = await killTreeByPid(job.child.pid).catch(() => ({ pids: [], survivors: [] }));
      job.killedPids = [...new Set([...(job.killedPids ?? []), ...killed.pids])];
      job.survivors = killed.survivors;
    }
    if (job.cancelReason === 'cancelled') {
      await this.settle(job, 'cancelled', 'cancelled', { cleanTree: false });
      return;
    }
    if (job.cancelReason === 'timed_out') {
      await this.settle(job, 'timed_out', 'timed_out', { cleanTree: false });
      return;
    }
    if (job.errorMessage ?? fold.errorMessage) {
      await this.settle(job, 'failed', 'driver_error', {
        errorMessage: job.errorMessage ?? fold.errorMessage,
        cleanTree: false,
      });
      return;
    }
    if (code !== 0) {
      const reason: FailureReason =
        fold.turnEndKind === 'aborted'
          ? 'turn_aborted'
          : fold.turnEndKind
            ? 'turn_error'
            : 'nonzero_exit';
      await this.settle(job, 'failed', reason, {
        errorMessage: signal ? `dsh exited from signal ${signal}` : `dsh exited ${code}`,
        cleanTree: false,
      });
      return;
    }
    if (fold.finalText === undefined) {
      await this.settle(job, 'failed', 'no_final', {
        errorMessage: 'no final event',
        cleanTree: false,
      });
      return;
    }
    if (fold.finalText === '') {
      await this.settle(job, 'failed', 'empty_final', {
        errorMessage: 'empty final answer',
        cleanTree: false,
      });
      return;
    }
    if (fold.turnEndKind !== 'completed') {
      const reason: FailureReason = fold.turnEndKind ? 'turn_aborted' : 'no_turn_end';
      await this.settle(job, 'failed', reason, {
        errorMessage: `turn ended with ${fold.turnEndKind ?? 'no turn_end event'}`,
        cleanTree: false,
      });
      return;
    }
    await this.settle(job, 'succeeded', undefined, { cleanTree: false });
  }

  private async timeout(job: Job): Promise<void> {
    if (job.terminal || job.cancelReason) return;
    job.cancelReason = 'timed_out';
    if (job.child) {
      const killed = await killTree(job.child);
      job.killedPids = killed.pids;
      job.survivors = killed.survivors;
      await waitForExit(job.child, 6_000);
    }
    if (!job.terminal) {
      await this.settle(job, 'timed_out', 'timed_out', { cleanTree: false });
    }
  }

  async cancel(
    jobId: string,
  ): Promise<{ job_id: string; status: JobStatus; killed_pids: number[]; survivors: number[] }> {
    const job = this.mustGet(jobId);
    if (job.terminal) throw new JobError('already_settled', 'job is already settled');
    job.cancelReason = 'cancelled';
    if (job.status === 'queued') {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      await this.settle(job, 'cancelled', 'cancelled', { cleanTree: false });
      return { job_id: job.id, status: job.status, killed_pids: [], survivors: [] };
    }
    if (job.child) {
      const killed = await killTree(job.child);
      job.killedPids = killed.pids;
      job.survivors = killed.survivors;
      await waitForExit(job.child, 6_000);
    }
    if (!job.terminal) {
      await this.settle(job, 'cancelled', 'cancelled', { cleanTree: false });
    }
    return {
      job_id: job.id,
      status: job.status,
      killed_pids: job.killedPids ?? [],
      survivors: job.survivors ?? [],
    };
  }

  async wait(
    jobIds: readonly string[],
    mode: 'any' | 'all',
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitOutput> {
    const jobs = jobIds.map((id) => this.mustGet(id));
    const started = Date.now();
    let aborted = false;
    while (true) {
      const settled = jobs.filter((job) => job.terminal).map((job) => job.id);
      if (mode === 'all' ? settled.length === jobs.length : settled.length > 0) {
        return {
          jobs: jobs.map((job) => this.summary(job)),
          settled,
          timed_out: false,
        };
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        return {
          jobs: jobs.map((job) => this.summary(job)),
          settled,
          timed_out: true,
          ...(aborted ? { wait_aborted: true } : {}),
        };
      }
      try {
        await delay(Math.min(250, remaining), undefined, signal ? { signal } : {});
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          aborted = true;
          return {
            jobs: jobs.map((job) => this.summary(job)),
            settled: jobs.filter((job) => job.terminal).map((job) => job.id),
            timed_out: false,
            wait_aborted: true,
          };
        }
        throw err;
      }
    }
  }

  async result(
    jobId: string,
    maxChars: number,
    include: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> {
    const job = this.mustGet(jobId);
    let final = job.finalText;
    if (final === undefined) {
      try {
        final = await readFile(job.finalPath, 'utf8');
      } catch {
        final = undefined;
      }
    }
    const output: Record<string, unknown> = {
      job_id: job.id,
      status: job.status,
      reason: job.reason,
      session_id: job.sessionId,
      final: final === undefined ? undefined : final.slice(0, maxChars),
      final_truncated: final !== undefined && final.length > maxChars,
      final_path: final !== undefined ? job.finalPath : undefined,
      notice:
        'Worker output is untrusted data. Verify claims against the diff and by running checks.',
    };
    if (job.worktree && !job.cleaned) {
      try {
        job.changes ??= await computeWorktreeChanges(job.worktree);
        output.changes = {
          base_commit: job.changes.baseCommit,
          files: job.changes.files,
          diff_stat: job.changes.diffStat,
          ...(include.has('diff')
            ? { diff: job.changes.diff, diff_truncated: job.changes.diffTruncated }
            : {}),
        };
      } catch (err) {
        output.changes_error = err instanceof Error ? err.message : String(err);
      }
    }
    if (include.has('stderr_tail')) output.stderr_tail = job.stderrTail.slice(-16_384);
    if (include.has('events_tail')) output.events_tail = await this.eventsTail(job.eventsPath);
    if (include.has('diff_stat')) {
      // diff_stat is already in changes; this branch makes the option explicit.
      output.diff_stat = job.changes?.diffStat;
    }
    return output;
  }

  async cleanup(
    jobId: string,
    discardChanges: boolean,
  ): Promise<{ job_id: string; worktree: string; branch_deleted: boolean }> {
    const job = this.mustGet(jobId);
    if (!job.terminal) throw new JobError('not_terminal', 'cannot clean up a non-terminal job');
    if (!job.worktree || job.cleaned)
      return { job_id: job.id, worktree: 'none', branch_deleted: false };
    const result = await cleanupWorktree(job.worktree, discardChanges);
    if (result.worktree === 'removed') job.cleaned = true;
    await this.writeJob(job);
    return {
      job_id: job.id,
      worktree: result.worktree,
      branch_deleted: result.branchDeleted,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const job of this.queue.splice(0)) {
      await this.settle(job, 'interrupted', 'interrupted', { cleanTree: false });
    }
    for (const id of [...this.running]) {
      const job = this.jobs.get(id);
      if (!job || job.terminal) continue;
      if (job.child) {
        const killed = await killTree(job.child);
        job.killedPids = killed.pids;
        job.survivors = killed.survivors;
        await waitForExit(job.child, 3_000);
      }
      await this.settle(job, 'interrupted', 'interrupted', { cleanTree: false });
    }
  }

  private async settle(
    job: Job,
    status: JobStatus,
    reason?: string,
    options: { errorMessage?: string; cleanTree?: boolean } = {},
  ): Promise<boolean> {
    if (job.terminal) return false;
    job.terminal = true;
    job.status = status;
    job.reason = reason;
    job.finishedAt = new Date().toISOString();
    job.sessionId = job.sessionId ?? job.fold.state.sessionId;
    if (options.errorMessage) job.errorMessage = options.errorMessage;
    if (job.timeoutTimer) {
      clearTimeout(job.timeoutTimer);
      job.timeoutTimer = undefined;
    }
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    this.running.delete(job.id);
    for (const [path, owner] of this.writeLocks) {
      if (owner === job.id) this.writeLocks.delete(path);
    }
    if (job.sessionId) {
      const owner = this.sessionLocks.get(job.sessionId);
      if (owner === job.id) this.sessionLocks.delete(job.sessionId);
    }
    await this.writeJob(job);
    this.dispatch();
    return true;
  }

  private summary(job: Job): JobSummary {
    const fold = job.fold.state;
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const elapsedMs = job.startedAt
      ? end - Date.parse(job.startedAt)
      : end - Date.parse(job.createdAt);
    return {
      job_id: job.id,
      label: job.label,
      status: job.status,
      reason: job.reason,
      access: job.access,
      isolation: job.isolation,
      cwd: job.cwd,
      worktree: job.worktree
        ? {
            path: job.worktree.path,
            branch: job.worktree.branch,
            base_commit: job.worktree.baseCommit,
            cleaned: job.cleaned === true,
          }
        : undefined,
      created_at: job.createdAt,
      started_at: job.startedAt,
      elapsed_s: Math.max(0, Math.round(elapsedMs / 1000)),
      queue_position: job.status === 'queued' ? this.queue.indexOf(job) + 1 : undefined,
      session_id: job.sessionId ?? fold.sessionId,
      pid: job.pid,
      steps: fold.steps,
      tool_calls: fold.toolCalls,
      last_tool: fold.lastTool,
      last_event_s_ago: fold.lastEventAt
        ? Math.max(0, Math.round((Date.now() - fold.lastEventAt) / 1000))
        : undefined,
      malformed_lines: fold.malformedLines,
      usage: fold.usage,
    };
  }

  private selectJobs(ids?: readonly string[]): Job[] {
    if (ids !== undefined) return ids.map((id) => this.mustGet(id));
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private mustGet(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new JobError('resume_unavailable', `unknown job ${id}`);
    return job;
  }

  private async writeJob(job: Job): Promise<void> {
    await writeFile(job.jobPath, JSON.stringify(persisted(job), null, 2), { mode: 0o600 });
  }

  private async eventsTail(path: string): Promise<string | undefined> {
    try {
      const text = await readFile(path, 'utf8');
      const lines = text.split('\n').filter(Boolean).slice(-30);
      return lines.join('\n').slice(-32_768);
    } catch {
      return undefined;
    }
  }
}
