import { isActiveStatus } from '../admin.js';
import type { JobManager } from '../jobs.js';
import type { JobSummary } from '../types.js';
import { VERSION } from '../version.js';
import { CONTROL_PROTOCOL } from './descriptor.js';
import {
  ControlError,
  type ControlHealth,
  type ControlJobs,
  JOB_ID_PATTERN,
  type JobView,
} from './protocol.js';

type ControlFacts = NonNullable<Awaited<ReturnType<JobManager['controlFacts']>>>;

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new ControlError('invalid_job_id', 'invalid job id');
  }
}

function buildJobView(summary: JobSummary, facts: ControlFacts): JobView {
  const active = isActiveStatus(summary.status);
  const owned = facts.owned;
  return {
    job_id: summary.job_id,
    label: summary.label ?? null,
    status: summary.status,
    reason: summary.reason ?? null,
    backend: summary.backend,
    owner_id: summary.owner_id,
    owned,
    group_id: summary.group_id,
    group_name: summary.group_name,
    profile: summary.profile,
    provider: summary.provider ?? null,
    model: summary.model ?? null,
    access: summary.access,
    isolation: summary.isolation,
    cwd: summary.cwd,
    worktree: summary.worktree
      ? {
          path: summary.worktree.path,
          branch: summary.worktree.branch,
          base_commit: summary.worktree.base_commit,
          repo_root: summary.worktree.repo_root,
          cleaned: facts.cleaned,
        }
      : null,
    created_at: summary.created_at,
    started_at: summary.started_at ?? null,
    finished_at: summary.finished_at ?? null,
    elapsed_s: summary.elapsed_s ?? 0,
    queue_position: summary.queue_position ?? null,
    session_id: summary.session_id ?? null,
    pid: summary.pid ?? null,
    steps: summary.steps,
    tool_calls: summary.tool_calls,
    last_tool: summary.last_tool ?? null,
    last_event_s_ago: summary.last_event_s_ago ?? null,
    malformed_lines: summary.malformed_lines,
    events_count: summary.events_count,
    usage: summary.usage ?? null,
    cost_usd: summary.cost_usd ?? null,
    alerts: summary.alerts,
    resume_of: summary.resume_of ?? null,
    steered_from: summary.steered_from ?? null,
    capabilities: {
      cancel: owned && active,
      steer:
        owned &&
        summary.session_id !== undefined &&
        facts.supports_resume &&
        (active || !facts.cleaned),
      cleanup:
        owned &&
        !active &&
        summary.worktree !== undefined &&
        !facts.cleaned &&
        !facts.worktree_busy,
      delete: owned && !active && !facts.worktree_busy && !facts.session_busy,
      read_result: true,
      read_events: true,
    },
  };
}

function healthFrom(
  manager: JobManager,
  status: Awaited<ReturnType<JobManager['statusOutput']>>,
): ControlHealth {
  const server = status.server;
  return {
    ok: true,
    protocol: CONTROL_PROTOCOL,
    version: VERSION,
    owner_id: manager.owner,
    pid: process.pid,
    ready: true,
    state_dir: server.state_dir,
    backend: server.backend,
    max_concurrent: server.max_concurrent,
    max_queue: server.max_queue,
    running: server.running,
    queued: server.queued,
  };
}

/**
 * A thin adapter over JobManager for the local HTTP control API. Ownership and
 * capability checks live here so the HTTP layer only validates input and maps
 * errors to status codes.
 */
export function createControlService(manager: JobManager) {
  async function factsFor(jobId: string): Promise<ControlFacts> {
    assertJobId(jobId);
    const facts = await manager.controlFacts(jobId);
    if (!facts) throw new ControlError('unknown_job', `unknown job ${jobId}`);
    return facts;
  }

  async function requireOwned(jobId: string): Promise<ControlFacts> {
    const facts = await factsFor(jobId);
    if (!facts.owned) {
      throw new ControlError('not_owner', 'job is owned by another manager', {
        job_id: jobId,
      });
    }
    return facts;
  }

  async function getJob(jobId: string): Promise<JobView> {
    assertJobId(jobId);
    const status = await manager.statusOutput();
    const summary = status.jobs.find((job) => job.job_id === jobId);
    if (!summary) throw new ControlError('unknown_job', `unknown job ${jobId}`);
    return buildJobView(summary, await factsFor(jobId));
  }

  async function listJobs(): Promise<ControlJobs> {
    const status = await manager.statusOutput();
    const jobs: JobView[] = [];
    for (const summary of status.jobs) {
      const facts = await manager.controlFacts(summary.job_id);
      // A job deleted while the list was being assembled is simply omitted.
      if (!facts) continue;
      jobs.push(buildJobView(summary, facts));
    }
    return { server: healthFrom(manager, status), jobs };
  }

  return {
    async health(): Promise<ControlHealth> {
      return healthFrom(manager, await manager.statusOutput());
    },

    listJobs,

    getJob,

    async events(jobId: string, cursor: number, limit: number) {
      await factsFor(jobId);
      return manager.events(jobId, cursor, limit);
    },

    async result(jobId: string, maxChars: number, include: string[]) {
      await factsFor(jobId);
      return manager.result(jobId, maxChars, new Set(include));
    },

    async cancel(jobId: string) {
      await requireOwned(jobId);
      return manager.cancel(jobId);
    },

    async steer(jobId: string, message: string, timeoutS?: number) {
      await requireOwned(jobId);
      return manager.steer({
        job_id: jobId,
        message,
        ...(timeoutS === undefined ? {} : { timeout_s: timeoutS }),
      });
    },

    async cleanup(jobId: string, discardChanges: boolean) {
      await requireOwned(jobId);
      return manager.cleanup(jobId, discardChanges);
    },

    async delete(jobId: string, discardChanges: boolean) {
      await requireOwned(jobId);
      return manager.delete(jobId, discardChanges);
    },
  };
}

export type ControlService = ReturnType<typeof createControlService>;
