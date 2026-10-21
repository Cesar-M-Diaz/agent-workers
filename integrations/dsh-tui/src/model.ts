import { type ActionKind, describePending, type PendingAction } from './actions.js';
import type { JobCapabilities } from './control-client.js';
import { displayWidth, fitText, sanitizeText } from './sanitize.js';
import {
  isActiveStatus,
  isTerminalStatus,
  type WorkerEvent,
  type WorkerJob,
} from './state-reader.js';

export type ControlState = 'offline' | { readonly owners: number };

export interface JobControlView {
  readonly ownerId: string;
  readonly capabilities: JobCapabilities;
}

/** Control information gathered by the store, kept separate from the read model. */
export interface ModelControl {
  readonly state: ControlState;
  readonly jobs?: ReadonlyMap<string, JobControlView>;
  readonly pending?: PendingAction | null;
  readonly needsDiscard?: ReadonlyMap<string, ActionKind>;
  readonly busy?: ReadonlySet<string>;
  readonly message?: string | null;
  readonly errors?: ReadonlyMap<string, string>;
}

export interface ModelOptions {
  width: number;
  selectedId?: string;
  showAll?: boolean;
  cwd?: string;
  now?: number;
  error?: string | null;
  control?: ModelControl;
}

export interface JobRow {
  id: string;
  label: string;
  status: string;
  glyph: string;
  active: boolean;
  groupId: string;
  groupName: string;
  selected: boolean;
  lines: string[];
}

export interface JobGroup {
  id: string;
  name: string;
  active: boolean;
  rows: JobRow[];
}

export interface JobDetail {
  id: string;
  lines: string[];
}

export interface WorkersModel {
  width: number;
  header: string[];
  banner: string;
  footer: string;
  control?: string;
  groups: JobGroup[];
  rows: JobRow[];
  detail?: JobDetail;
  error?: string;
  empty: boolean;
}

export function controlStatusLine(control: ModelControl | undefined): string | undefined {
  if (control === undefined) return undefined;
  if (control.state === 'offline') return 'control offline — read-only';
  return `control: ${control.state.owners} owner${control.state.owners === 1 ? '' : 's'}`;
}

const STATUS: Record<string, { glyph: string; label: string }> = {
  queued: { glyph: '○', label: 'queued' },
  starting: { glyph: '◌', label: 'starting' },
  running: { glyph: '●', label: 'running' },
  succeeded: { glyph: '✓', label: 'succeeded' },
  failed: { glyph: '✗', label: 'failed' },
  timed_out: { glyph: '✗', label: 'timed out' },
  cancelled: { glyph: '−', label: 'cancelled' },
  interrupted: { glyph: '⚠', label: 'interrupted' },
  unknown: { glyph: '?', label: 'unknown' },
};

const LEGACY_GROUP = 'Legacy / ungrouped';
const LEGACY_KEY = '__legacy__';

function statusOf(job: WorkerJob): { glyph: string; label: string } {
  return STATUS[job.status] ?? STATUS.unknown ?? { glyph: '?', label: 'unknown' };
}

function statusLabel(job: WorkerJob): string {
  if (job.status !== 'unknown') return statusOf(job).label;
  return job.rawStatus !== undefined ? `unknown (${job.rawStatus})` : 'unknown';
}

function groupKey(job: WorkerJob): string {
  return job.groupId ?? LEGACY_KEY;
}

function groupName(job: WorkerJob): string {
  if (job.groupId !== undefined) return job.groupName ?? job.groupId;
  return job.groupName ?? LEGACY_GROUP;
}

function timestamp(job: WorkerJob): number {
  const parsed = Date.parse(job.startedAt ?? job.createdAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 'n/a';
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(4)}`;
}

function formatElapsed(job: WorkerJob, now: number): string {
  const started = Date.parse(job.startedAt ?? job.createdAt ?? '');
  if (!Number.isFinite(started)) return 'n/a';
  const finished = Date.parse(job.finishedAt ?? '');
  const end = Number.isFinite(finished) ? finished : now;
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatTime(value: string | undefined): string {
  if (value === undefined) return 'n/a';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(value);
  if (match !== null) return `${match[1] ?? ''} ${match[2] ?? ''}`;
  return sanitizeText(value);
}

function normalizePath(value: string): string {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

function belongsToCwd(job: WorkerJob, cwd: string): boolean {
  const root = normalizePath(cwd);
  const candidates = [job.cwd, job.worktree?.repoRoot, job.worktree?.path];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const path = normalizePath(candidate);
    if (path === root) return true;
    if (path.startsWith(`${root}/`) || root.startsWith(`${path}/`)) return true;
  }
  return false;
}

function pushLine(lines: string[], width: number, text: string): void {
  lines.push(fitText(text, width));
}

function rowLines(job: WorkerJob, width: number, now: number, selected: boolean): string[] {
  const { glyph } = statusOf(job);
  const marker = selected ? '▸' : '·';
  const head =
    job.status === 'unknown'
      ? `${marker} ${glyph} ${statusLabel(job)} · ${job.label}`
      : `${marker} ${glyph} ${job.label}`;

  const suffix = ` · ${job.steps} steps · ${formatCost(job.costUsd)} · ${formatElapsed(job, now)}`;
  const available = width - displayWidth(suffix);
  const modelText = available >= 4 ? fitText(job.model ?? 'model n/a', available) : '';
  const lines = [fitText(head, width), fitText(`${modelText}${suffix}`, width)];

  const alert = job.alerts[0];
  if (alert !== undefined) {
    const extra = job.alerts.length > 1 ? ` (+${job.alerts.length - 1})` : '';
    pushLine(
      lines,
      width,
      `! ${alert.kind}${alert.message !== undefined ? `: ${alert.message}` : ''}${extra}`,
    );
  }
  if (job.jobJsonInvalid === true) {
    pushLine(lines, width, '! job.json torn; showing last valid copy');
  }
  return lines;
}

function mark(capabilities: JobCapabilities | undefined, action: ActionKind): string {
  return capabilities?.[action] === true ? '✓' : '✗';
}

function detailLines(job: WorkerJob, width: number, now: number, control?: ModelControl): string[] {
  const lines: string[] = [];
  const add = (text: string): void => pushLine(lines, width, text);

  add(`detail ${job.id}`);
  add(`label ${job.label}`);
  add(`status ${statusLabel(job)}${job.reason !== undefined ? ` · ${job.reason}` : ''}`);
  if (job.jobJsonInvalid === true) add('warning job.json torn; showing last valid copy');
  if (job.ownerId !== undefined) add(`owner ${job.ownerId}`);
  if (control !== undefined) {
    const capabilities = control.jobs?.get(job.id)?.capabilities;
    add(`cancel ${mark(capabilities, 'cancel')} · steer unavailable`);
    add(`cleanup ${mark(capabilities, 'cleanup')} · delete ${mark(capabilities, 'delete')}`);
    const discard = control.needsDiscard?.get(job.id);
    if (discard !== undefined) add(`discard & ${discard}?`);
    if (control.busy?.has(job.id) === true) add('action running');
    const actionError = control.errors?.get(job.id);
    if (actionError !== undefined && actionError !== '') add(`action error ${actionError}`);
  }
  add(`backend ${job.backend} · profile ${job.profile ?? 'n/a'}`);
  add(`model ${job.provider !== undefined ? `${job.provider} / ` : ''}${job.model ?? 'n/a'}`);
  add(`access ${job.access ?? 'n/a'} · isolation ${job.isolation ?? 'n/a'}`);
  add(`cwd ${job.cwd ?? 'n/a'}`);

  const worktree = job.worktree;
  add(`worktree ${worktree?.path ?? 'none'}${job.cleaned ? ' · cleaned' : ''}`);
  if (worktree?.branch !== undefined) add(`branch ${worktree.branch}`);

  add(`session ${job.sessionId ?? 'n/a'}`);
  if (job.sessionDir !== undefined) add(`session dir ${job.sessionDir}`);
  if (job.resumeOf !== undefined || job.steeredFrom !== undefined) {
    const resume = job.resumeOf !== undefined ? `resume ${job.resumeOf}` : undefined;
    const steered = job.steeredFrom !== undefined ? `steered ${job.steeredFrom}` : undefined;
    add(`lineage ${[resume, steered].filter(Boolean).join(' · ')}`);
  }

  add(`created ${formatTime(job.createdAt)}`);
  add(`started ${formatTime(job.startedAt)}`);
  if (job.finishedAt !== undefined) add(`finished ${formatTime(job.finishedAt)}`);
  add(`elapsed ${formatElapsed(job, now)}`);

  if (job.usage !== undefined) {
    const input = job.usage.inputTokens ?? 0;
    const output = job.usage.outputTokens ?? 0;
    const total = job.usage.totalTokens ?? input + output;
    add(`usage in ${input} · out ${output} · total ${total}`);
    if (
      job.usage.cacheReadTokens !== undefined ||
      job.usage.cacheWriteTokens !== undefined ||
      job.usage.reasoningTokens !== undefined
    ) {
      add(
        `cache r ${job.usage.cacheReadTokens ?? 0} · w ${job.usage.cacheWriteTokens ?? 0}` +
          (job.usage.reasoningTokens !== undefined
            ? ` · reasoning ${job.usage.reasoningTokens}`
            : ''),
      );
    }
  } else {
    add('usage n/a');
  }
  add(`cost ${formatCost(job.costUsd)}`);

  const busy = [job.worktreeBusy ? 'worktree' : '', job.sessionBusy ? 'session' : ''].filter(
    Boolean,
  );
  if (busy.length > 0) add(`busy ${busy.join(' · ')}`);

  if (job.alerts.length === 0) {
    add('alerts none');
  } else {
    for (const alert of job.alerts) {
      add(
        `alert ${alert.kind}${alert.message !== undefined ? `: ${alert.message}` : ''}` +
          (alert.since !== undefined ? ` · since ${alert.since}` : ''),
      );
    }
  }

  const calls = job.events.filter((event: WorkerEvent) => event.type === 'tool_call').slice(-8);
  if (calls.length === 0) {
    add('tools none');
  } else {
    add(`tools (last ${calls.length})`);
    for (const call of calls) {
      add(`${call.tool ?? 'tool'}${call.summary !== undefined ? `: ${call.summary}` : ''}`);
    }
  }

  if (job.lastText !== undefined) add(`text ${job.lastText}`);
  if (job.errorMessage !== undefined) add(`error ${job.errorMessage}`);
  if (job.lastError !== undefined && job.lastError !== job.errorMessage) {
    add(`event error ${job.lastError}`);
  }

  if (job.finalTooLarge === true) {
    add('final too large (> 1 MB)');
  } else if (job.finalText !== undefined) {
    add('final');
    const preview = job.finalText
      .split(/\r?\n/)
      .map((line) => sanitizeText(line))
      .filter((line) => line !== '')
      .slice(0, 8);
    for (const line of preview) add(`· ${line}`);
  } else if (isTerminalStatus(job.status)) {
    add('final none');
  }

  if (job.stderrTail !== undefined) {
    const stderr = job.stderrTail
      .split(/\r?\n/)
      .map((line) => sanitizeText(line))
      .filter((line) => line !== '')
      .slice(0, 3);
    if (stderr.length > 0) {
      add('stderr');
      for (const line of stderr) add(`· ${line}`);
    }
  }

  return lines;
}

function footerLine(
  control: ModelControl | undefined,
  selected: WorkerJob | undefined,
  width: number,
): string {
  if (control?.pending !== undefined && control.pending !== null) {
    return fitText(describePending(control.pending), width);
  }
  const discard = selected !== undefined ? control?.needsDiscard?.get(selected.id) : undefined;
  if (discard !== undefined) return fitText(`discard & ${discard}?`, width);
  if (control?.message !== undefined && control.message !== null && control.message !== '') {
    return fitText(control.message, width);
  }
  return fitText('↑↓ enter r a · c x d', width);
}

/** Build the complete, width-bounded, sanitized view model. */
export function buildModel(jobs: readonly WorkerJob[], options: ModelOptions): WorkersModel {
  const width = Math.max(1, Math.floor(options.width));
  const now = options.now ?? Date.now();
  const showAll = options.showAll === true;
  const cwd = options.cwd?.trim();
  const control = options.control;

  let scoped = false;
  let visible: WorkerJob[] = [...jobs];
  if (!showAll && cwd !== undefined && cwd !== '') {
    const matching = new Set(
      jobs.filter((job) => belongsToCwd(job, cwd)).map((job) => groupKey(job)),
    );
    if (matching.size > 0) {
      scoped = true;
      visible = jobs.filter((job) => matching.has(groupKey(job)));
    }
  }

  const running = visible.filter(
    (job) => job.status === 'running' || job.status === 'starting',
  ).length;
  const queued = visible.filter((job) => job.status === 'queued').length;
  const done = visible.filter((job) => isTerminalStatus(job.status)).length;
  const knownCosts = visible
    .map((job) => job.costUsd)
    .filter((value): value is number => value !== undefined);
  const totalCost =
    knownCosts.length === 0 ? 'n/a' : formatCost(knownCosts.reduce((sum, value) => sum + value, 0));

  const header = [
    fitText('Workers', width),
    fitText(`${running} run · ${queued} queued · ${done} done`, width),
    fitText(`cost ${totalCost} · ${visible.length} jobs`, width),
  ];
  const statusLine = controlStatusLine(control);
  if (statusLine !== undefined) header.push(fitText(statusLine, width));

  const groupsMap = new Map<string, WorkerJob[]>();
  for (const job of visible) {
    const key = groupKey(job);
    const bucket = groupsMap.get(key);
    if (bucket === undefined) groupsMap.set(key, [job]);
    else bucket.push(job);
  }

  const selectedId = options.selectedId;
  const groups: JobGroup[] = [];
  for (const [id, bucket] of groupsMap) {
    const first = bucket[0];
    if (first === undefined) continue;
    const name = groupName(first);
    const active = bucket.some((job) => isActiveStatus(job.status));
    bucket.sort((left, right) => {
      const rank = (job: WorkerJob): number =>
        job.status === 'running' || job.status === 'starting' ? 0 : job.status === 'queued' ? 1 : 2;
      const byRank = rank(left) - rank(right);
      if (byRank !== 0) return byRank;
      const byTime = timestamp(right) - timestamp(left);
      if (byTime !== 0) return byTime;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    groups.push({
      id,
      name: fitText(name, width),
      active,
      rows: bucket.map((job) => ({
        id: job.id,
        label: job.label,
        status: job.status,
        glyph: statusOf(job).glyph,
        active: isActiveStatus(job.status),
        groupId: id,
        groupName: name,
        selected: job.id === selectedId,
        lines: rowLines(job, width, now, job.id === selectedId),
      })),
    });
  }
  groups.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });

  const rows = groups.flatMap((group) => group.rows);
  const selected = visible.find((job) => job.id === selectedId);
  const detail =
    selected !== undefined
      ? { id: selected.id, lines: detailLines(selected, width, now, control) }
      : undefined;

  const scope = showAll || !scoped ? 'all groups' : 'current project';
  const model: WorkersModel = {
    width,
    header,
    banner: fitText(control === undefined ? `read-only · ${scope}` : scope, width),
    footer: footerLine(control, selected, width),
    groups,
    rows,
    empty: rows.length === 0,
  };
  if (statusLine !== undefined) model.control = fitText(statusLine, width);
  if (detail !== undefined) model.detail = detail;
  if (options.error !== undefined && options.error !== null && options.error !== '') {
    model.error = fitText(`error ${options.error}`, width);
  }
  return model;
}

export { formatCost, formatElapsed, formatTime };
