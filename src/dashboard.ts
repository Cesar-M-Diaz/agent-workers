import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AlertKind, JobAlert } from './types.js';

interface PersistedJobFile {
  id?: string;
  label?: string;
  groupId?: string;
  groupName?: string;
  ownerId?: string;
  status?: string;
  reason?: string;
  cwd?: string;
  access?: string;
  isolation?: string;
  worktree?: {
    path?: string;
    branch?: string;
    baseCommit?: string;
    cleaned?: boolean;
  };
  sessionId?: string;
  profile?: string;
  provider?: string;
  model?: string;
  costUsd?: number;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  steps?: number;
  toolCalls?: number;
  lastTool?: string;
  eventsCount?: number;
  malformedLines?: number;
  usage?: Record<string, number>;
  alerts?: unknown;
  steeredFrom?: string;
}

export interface DashboardJob {
  id: string;
  label: string;
  group_id: string;
  group_name: string;
  owner_id: string;
  status: string;
  reason?: string;
  cwd: string;
  access?: string;
  isolation?: string;
  worktree: {
    path: string;
    branch: string;
    base_commit: string;
    cleaned: boolean;
  } | null;
  session_id?: string;
  profile?: string;
  provider?: string;
  model?: string;
  cost_usd?: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  elapsed_s: number;
  steps: number;
  tool_calls: number;
  last_tool?: string;
  events_count: number;
  malformed_lines: number;
  usage: Record<string, number> | null;
  last_event_at?: string;
  alerts: JobAlert[];
  steered_from?: string;
}

const ALERT_KINDS = new Set<AlertKind>(['stalled', 'loop', 'tool_errors', 'budget']);

function normalizeAlerts(value: unknown): JobAlert[] {
  if (!Array.isArray(value)) return [];
  const alerts: JobAlert[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const alert = entry as Record<string, unknown>;
    if (
      typeof alert.kind !== 'string' ||
      !ALERT_KINDS.has(alert.kind as AlertKind) ||
      typeof alert.message !== 'string' ||
      !alert.message.trim() ||
      typeof alert.since !== 'string'
    ) {
      continue;
    }
    alerts.push({
      kind: alert.kind as AlertKind,
      message: alert.message,
      since: alert.since,
    });
  }
  return alerts;
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'starting' || status === 'running';
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Read the persisted job files under the shared worker state directory. This
 * is intentionally read-only: the dashboard never mutates a job.
 */
export async function listDashboardJobs(stateDir: string): Promise<DashboardJob[]> {
  const root = join(stateDir, 'jobs');
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobs: DashboardJob[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const dir = join(root, entry.name);
    let saved: PersistedJobFile;
    try {
      saved = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) as PersistedJobFile;
    } catch {
      continue;
    }
    if (typeof saved.id !== 'string' || !validId(saved.id)) continue;

    const status = typeof saved.status === 'string' ? saved.status : 'unknown';
    const createdAt =
      typeof saved.createdAt === 'string' ? saved.createdAt : new Date(0).toISOString();
    const startedAt = typeof saved.startedAt === 'string' ? saved.startedAt : undefined;
    const finishedAt = typeof saved.finishedAt === 'string' ? saved.finishedAt : undefined;
    const startMs = Date.parse(startedAt ?? createdAt);
    const endMs = isActive(status) ? Date.now() : Date.parse(finishedAt ?? createdAt);
    let lastEventAt: string | undefined;
    try {
      lastEventAt = (await stat(join(dir, 'events.ndjson'))).mtime.toISOString();
    } catch {
      lastEventAt = undefined;
    }

    jobs.push({
      id: saved.id,
      label: typeof saved.label === 'string' && saved.label.trim() ? saved.label : saved.id,
      group_id:
        typeof saved.groupId === 'string' && saved.groupId.trim()
          ? saved.groupId
          : typeof saved.ownerId === 'string' && saved.ownerId.trim()
            ? saved.ownerId
            : 'legacy',
      group_name:
        typeof saved.groupName === 'string' && saved.groupName.trim()
          ? saved.groupName
          : 'Legacy / ungrouped',
      owner_id: typeof saved.ownerId === 'string' ? saved.ownerId : 'unknown',
      status,
      ...(typeof saved.reason === 'string' ? { reason: saved.reason } : {}),
      cwd: typeof saved.cwd === 'string' ? saved.cwd : '',
      ...(typeof saved.access === 'string' ? { access: saved.access } : {}),
      ...(typeof saved.isolation === 'string' ? { isolation: saved.isolation } : {}),
      worktree:
        saved.worktree &&
        typeof saved.worktree.path === 'string' &&
        typeof saved.worktree.branch === 'string' &&
        typeof saved.worktree.baseCommit === 'string'
          ? {
              path: saved.worktree.path,
              branch: saved.worktree.branch,
              base_commit: saved.worktree.baseCommit,
              cleaned: saved.worktree.cleaned === true,
            }
          : null,
      ...(typeof saved.sessionId === 'string' ? { session_id: saved.sessionId } : {}),
      ...(typeof saved.profile === 'string' ? { profile: saved.profile } : {}),
      ...(typeof saved.provider === 'string' ? { provider: saved.provider } : {}),
      ...(typeof saved.model === 'string' ? { model: saved.model } : {}),
      ...(typeof saved.costUsd === 'number' ? { cost_usd: saved.costUsd } : {}),
      created_at: createdAt,
      ...(startedAt ? { started_at: startedAt } : {}),
      ...(finishedAt ? { finished_at: finishedAt } : {}),
      elapsed_s:
        Number.isFinite(startMs) && Number.isFinite(endMs)
          ? Math.max(0, Math.round((Math.max(startMs, endMs) - startMs) / 1000))
          : 0,
      steps: Number.isFinite(saved.steps) ? Math.max(0, saved.steps ?? 0) : 0,
      tool_calls: Number.isFinite(saved.toolCalls) ? Math.max(0, saved.toolCalls ?? 0) : 0,
      ...(typeof saved.lastTool === 'string' ? { last_tool: saved.lastTool } : {}),
      events_count: Number.isFinite(saved.eventsCount) ? Math.max(0, saved.eventsCount ?? 0) : 0,
      malformed_lines: Number.isFinite(saved.malformedLines)
        ? Math.max(0, saved.malformedLines ?? 0)
        : 0,
      usage: saved.usage ?? null,
      ...(lastEventAt ? { last_event_at: lastEventAt } : {}),
      alerts: normalizeAlerts(saved.alerts),
      ...(typeof saved.steeredFrom === 'string' ? { steered_from: saved.steeredFrom } : {}),
    });
  }

  return jobs.sort((a, b) => {
    const activeOrder = Number(isActive(b.status)) - Number(isActive(a.status));
    if (activeOrder !== 0) return activeOrder;
    const groupOrder = a.group_name.localeCompare(b.group_name);
    if (groupOrder !== 0) return groupOrder;
    return b.created_at.localeCompare(a.created_at);
  });
}
