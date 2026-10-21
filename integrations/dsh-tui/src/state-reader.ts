import type { Dirent, Stats } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeText } from './sanitize.js';

export const EVENTS_MAX_BYTES = 3.5 * 1024 * 1024;
export const FINAL_MAX_BYTES = 1024 * 1024;

const JOB_ID = /^[A-Za-z0-9_-]+$/;
const ACTIVE = new Set(['queued', 'starting', 'running']);
const TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted']);

type UnknownRecord = Record<string, unknown>;

export interface JobUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface JobWorktree {
  path?: string;
  branch?: string;
  baseCommit?: string;
  repoRoot?: string;
  cleaned?: boolean;
}

export interface JobAlert {
  kind: string;
  message?: string;
  since?: string;
}

export interface WorkerEvent {
  type: string;
  sessionId?: string;
  phase?: string;
  usage?: JobUsage;
  reason?: string;
  callId?: string;
  tool?: string;
  summary?: string;
  status?: string;
  text?: string;
  message?: string;
}

export interface WorkerJob {
  id: string;
  label: string;
  backend: string;
  groupId?: string;
  groupName?: string;
  ownerId?: string;
  status: string;
  /** Present only when the writer used a status this client does not know. */
  rawStatus?: string;
  reason?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  turnEndKind?: string;
  errorMessage?: string;
  profile?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  access?: string;
  isolation?: string;
  worktree?: JobWorktree;
  cleaned: boolean;
  pid?: number;
  sessionId?: string;
  sessionDir?: string;
  steps: number;
  toolCalls: number;
  lastTool?: string;
  eventsCount: number;
  malformedLines: number;
  usage?: JobUsage;
  costUsd?: number;
  alerts: JobAlert[];
  resumeOf?: string;
  steeredFrom?: string;
  stderrTail?: string;
  events: WorkerEvent[];
  lastText?: string;
  lastError?: string;
  finalText?: string;
  finalTooLarge?: boolean;
  jobJsonInvalid?: boolean;
  worktreeBusy: boolean;
  sessionBusy: boolean;
  eventsMtimeMs?: number;
}

export interface ReadOptions {
  /** Events/final.md are read for this job even when it is terminal. */
  selectedId?: string;
}

export interface ReadResult {
  stateDir: string;
  jobs: WorkerJob[];
}

interface CacheEntry {
  jobMtimeMs?: number;
  jobSize?: number;
  job?: WorkerJob;
  invalid?: boolean;
  eventsMtimeMs?: number;
  eventsSize?: number;
  events?: WorkerEvent[];
  finalMtimeMs?: number;
  finalSize?: number;
  finalText?: string;
  finalTooLarge?: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  const result = sanitizeText(value);
  return result === '' ? undefined : result;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function isJobId(value: string): boolean {
  return JOB_ID.test(value);
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE.has(status);
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

function normalizeUsage(value: unknown): JobUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: JobUsage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const) {
    const found = count(value[key]);
    if (found !== undefined) usage[key] = found;
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function normalizeWorktree(value: unknown): JobWorktree | undefined {
  if (!isRecord(value)) return undefined;
  const worktree: JobWorktree = {};
  const path = text(value.path);
  const branch = text(value.branch);
  const baseCommit = text(value.baseCommit);
  const repoRoot = text(value.repoRoot);
  const cleaned = flag(value.cleaned);
  if (path !== undefined) worktree.path = path;
  if (branch !== undefined) worktree.branch = branch;
  if (baseCommit !== undefined) worktree.baseCommit = baseCommit;
  if (repoRoot !== undefined) worktree.repoRoot = repoRoot;
  if (cleaned !== undefined) worktree.cleaned = cleaned;
  return Object.keys(worktree).length === 0 ? undefined : worktree;
}

function normalizeAlerts(value: unknown): JobAlert[] {
  if (!Array.isArray(value)) return [];
  const alerts: JobAlert[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = text(item.kind) ?? 'unknown';
    const message = text(item.message);
    const since = text(item.since);
    const alert: JobAlert = { kind };
    if (message !== undefined) alert.message = message;
    if (since !== undefined) alert.since = since;
    alerts.push(alert);
  }
  return alerts;
}

const SUMMARY_KEYS = ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'url'];

function summarizeInput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of SUMMARY_KEYS) {
    const found = text(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function normalizeEvent(value: unknown): WorkerEvent | undefined {
  if (!isRecord(value)) return undefined;
  const type = text(value.type);
  if (type === undefined) return undefined;
  const event: WorkerEvent = { type };
  const sessionId = text(value.sessionId);
  const phase = text(value.phase);
  const reason = text(value.reason);
  const callId = text(value.callId);
  const tool = text(value.tool);
  const summary = summarizeInput(value.input);
  const status = text(value.status);
  const body = text(value.text) ?? text(value.message);
  const usage = normalizeUsage(value.usage);
  if (sessionId !== undefined) event.sessionId = sessionId;
  if (phase !== undefined) event.phase = phase;
  if (reason !== undefined) event.reason = reason;
  if (callId !== undefined) event.callId = callId;
  if (tool !== undefined) event.tool = tool;
  if (summary !== undefined) event.summary = summary;
  if (status !== undefined) event.status = status;
  if (usage !== undefined) event.usage = usage;
  if (body !== undefined) {
    if (type === 'error') event.message = body;
    else event.text = body;
  }
  return event;
}

function normalizeJob(value: UnknownRecord, fallbackId: string): WorkerJob {
  const parsedId = text(value.id);
  const id = parsedId !== undefined && isJobId(parsedId) ? parsedId : fallbackId;
  const rawStatus = text(value.status);
  const status =
    rawStatus !== undefined && (ACTIVE.has(rawStatus) || TERMINAL.has(rawStatus))
      ? rawStatus
      : 'unknown';
  const worktree = normalizeWorktree(value.worktree);
  const cleaned = value.cleaned === true || worktree?.cleaned === true;

  const job: WorkerJob = {
    id,
    label: text(value.label) ?? id,
    backend: text(value.backend) ?? 'dsh',
    status,
    cleaned,
    steps: count(value.steps) ?? 0,
    toolCalls: count(value.toolCalls) ?? 0,
    eventsCount: count(value.eventsCount) ?? 0,
    malformedLines: count(value.malformedLines) ?? 0,
    alerts: normalizeAlerts(value.alerts),
    events: [],
    worktreeBusy: false,
    sessionBusy: false,
  };

  if (rawStatus !== undefined && status === 'unknown') job.rawStatus = rawStatus;
  const fields: Array<[keyof WorkerJob, string | undefined]> = [
    ['groupId', text(value.groupId)],
    ['groupName', text(value.groupName)],
    ['ownerId', text(value.ownerId)],
    ['reason', text(value.reason)],
    ['createdAt', text(value.createdAt)],
    ['startedAt', text(value.startedAt)],
    ['finishedAt', text(value.finishedAt)],
    ['turnEndKind', text(value.turnEndKind)],
    ['errorMessage', text(value.errorMessage)],
    ['profile', text(value.profile)],
    ['provider', text(value.provider)],
    ['model', text(value.model)],
    ['cwd', text(value.cwd)],
    ['access', text(value.access)],
    ['isolation', text(value.isolation)],
    ['lastTool', text(value.lastTool)],
    ['sessionId', text(value.sessionId)],
    ['sessionDir', text(value.sessionDir)],
    ['resumeOf', text(value.resumeOf)],
    ['steeredFrom', text(value.steeredFrom)],
    ['stderrTail', text(value.stderrTail)],
  ];
  for (const [key, found] of fields) {
    if (found !== undefined) Object.assign(job, { [key]: found });
  }
  if (worktree !== undefined) job.worktree = worktree;
  const pid = count(value.pid);
  if (pid !== undefined) job.pid = pid;
  const usage = normalizeUsage(value.usage);
  if (usage !== undefined) job.usage = usage;
  const costUsd = money(value.costUsd);
  if (costUsd !== undefined) job.costUsd = costUsd;
  return job;
}

function applyBusy(jobs: WorkerJob[]): void {
  const active = jobs.filter((job) => isActiveStatus(job.status));
  for (const job of jobs) {
    const others = active.filter((other) => other.id !== job.id);
    job.worktreeBusy =
      job.worktree?.path !== undefined &&
      others.some((other) => other.worktree?.path === job.worktree?.path);
    job.sessionBusy = others.some(
      (other) =>
        (job.sessionDir !== undefined && other.sessionDir === job.sessionDir) ||
        (job.sessionId !== undefined && other.sessionId === job.sessionId),
    );
  }
}

function parseEvents(source: string, startsMidFile: boolean): WorkerEvent[] {
  let textSource = source;
  if (startsMidFile) {
    const newline = textSource.indexOf('\n');
    textSource = newline >= 0 ? textSource.slice(newline + 1) : '';
  }
  const complete = textSource.endsWith('\n');
  const lines = textSource.split('\n');
  if (!complete) lines.pop();

  const events: WorkerEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const event = normalizeEvent(parsed);
      if (event !== undefined) events.push(event);
    } catch {
      // A malformed or partially written line is expected.
    }
  }
  return events;
}

function deriveLast(events: readonly WorkerEvent[]): {
  lastText?: string;
  lastError?: string;
} {
  let lastText: string | undefined;
  let lastError: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (lastText === undefined && (event.type === 'text' || event.type === 'final')) {
      if (event.text !== undefined) lastText = event.text;
    }
    if (lastError === undefined && event.type === 'error' && event.message !== undefined) {
      lastError = event.message;
    }
    if (lastText !== undefined && lastError !== undefined) break;
  }
  return { lastText, lastError };
}

export class StateReader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly stateDir: string) {}

  async read(options: ReadOptions = {}): Promise<ReadResult> {
    const jobsDir = join(this.stateDir, 'jobs');
    let entries: Dirent[];
    try {
      entries = await readdir(jobsDir, { withFileTypes: true });
    } catch {
      return { stateDir: this.stateDir, jobs: [] };
    }

    const ids = entries
      .filter((entry) => entry.isDirectory() && isJobId(entry.name))
      .map((entry) => entry.name)
      .sort();
    const seen = new Set(ids);
    for (const id of this.cache.keys()) {
      if (!seen.has(id)) this.cache.delete(id);
    }

    const jobs: WorkerJob[] = [];
    for (const id of ids) {
      const job = await this.loadJob(id);
      if (job !== undefined) jobs.push(job);
    }
    applyBusy(jobs);

    for (const job of jobs) {
      const entry = this.cache.get(job.id);
      if (entry === undefined) continue;
      if (isActiveStatus(job.status) || options.selectedId === job.id) {
        await this.attachEvents(job, entry);
      } else {
        job.events = [];
      }
      if (options.selectedId === job.id && isTerminalStatus(job.status)) {
        await this.attachFinal(job, entry);
      } else {
        job.finalText = undefined;
        job.finalTooLarge = undefined;
      }
    }

    return { stateDir: this.stateDir, jobs };
  }

  private async loadJob(id: string): Promise<WorkerJob | undefined> {
    const jobPath = join(this.stateDir, 'jobs', id, 'job.json');
    let info: Stats;
    try {
      info = await stat(jobPath);
    } catch {
      this.cache.delete(id);
      return undefined;
    }

    const entry = this.cache.get(id) ?? {};
    this.cache.set(id, entry);
    if (
      entry.job !== undefined &&
      entry.jobMtimeMs === info.mtimeMs &&
      entry.jobSize === info.size
    ) {
      const kept: WorkerJob = { ...entry.job };
      if (entry.invalid === true) kept.jobJsonInvalid = true;
      return kept;
    }

    try {
      const source = await readFile(jobPath, 'utf8');
      const parsed: unknown = JSON.parse(source);
      if (!isRecord(parsed)) throw new Error('job.json is not an object');
      entry.job = normalizeJob(parsed, id);
      entry.invalid = false;
      entry.jobMtimeMs = info.mtimeMs;
      entry.jobSize = info.size;
      return { ...entry.job };
    } catch {
      entry.jobMtimeMs = info.mtimeMs;
      entry.jobSize = info.size;
      if (entry.job === undefined) {
        this.cache.delete(id);
        return undefined;
      }
      entry.invalid = true;
      return { ...entry.job, jobJsonInvalid: true };
    }
  }

  private async attachEvents(job: WorkerJob, entry: CacheEntry): Promise<void> {
    const eventsPath = join(this.stateDir, 'jobs', job.id, 'events.ndjson');
    let info: Stats;
    try {
      info = await stat(eventsPath);
    } catch {
      entry.events = [];
      entry.eventsMtimeMs = undefined;
      entry.eventsSize = undefined;
      job.events = [];
      return;
    }

    if (
      entry.events !== undefined &&
      entry.eventsMtimeMs === info.mtimeMs &&
      entry.eventsSize === info.size
    ) {
      job.events = entry.events;
      job.eventsMtimeMs = info.mtimeMs;
    } else {
      try {
        const handle = await open(eventsPath, 'r');
        try {
          const actual = await handle.stat();
          const length = Math.min(actual.size, EVENTS_MAX_BYTES);
          const start = actual.size - length;
          const buffer = Buffer.alloc(length);
          let offset = 0;
          while (offset < length) {
            const result = await handle.read(buffer, offset, length - offset, start + offset);
            if (result.bytesRead === 0) break;
            offset += result.bytesRead;
          }
          const raw = buffer.subarray(0, offset).toString('utf8');
          entry.events = parseEvents(raw, start > 0);
          entry.eventsMtimeMs = actual.mtimeMs;
          entry.eventsSize = actual.size;
        } finally {
          await handle.close();
        }
      } catch {
        entry.events = [];
        entry.eventsMtimeMs = info.mtimeMs;
        entry.eventsSize = info.size;
      }
      job.events = entry.events;
      job.eventsMtimeMs = entry.eventsMtimeMs;
    }
    const last = deriveLast(job.events);
    job.lastText = last.lastText;
    job.lastError = last.lastError;
  }

  private async attachFinal(job: WorkerJob, entry: CacheEntry): Promise<void> {
    const finalPath = join(this.stateDir, 'jobs', job.id, 'final.md');
    let info: Stats;
    try {
      info = await stat(finalPath);
    } catch {
      entry.finalText = undefined;
      entry.finalTooLarge = undefined;
      entry.finalMtimeMs = undefined;
      entry.finalSize = undefined;
      return;
    }

    if (entry.finalMtimeMs === info.mtimeMs && entry.finalSize === info.size) {
      job.finalText = entry.finalText;
      job.finalTooLarge = entry.finalTooLarge;
      return;
    }

    entry.finalMtimeMs = info.mtimeMs;
    entry.finalSize = info.size;
    if (info.size > FINAL_MAX_BYTES) {
      entry.finalText = undefined;
      entry.finalTooLarge = true;
    } else {
      try {
        entry.finalText = await readFile(finalPath, 'utf8');
        entry.finalTooLarge = false;
      } catch {
        entry.finalText = undefined;
        entry.finalTooLarge = undefined;
      }
    }
    job.finalText = entry.finalText;
    job.finalTooLarge = entry.finalTooLarge;
  }
}

/** Parse an NDJSON event stream (exported for reader tests). */
export function parseEventSource(source: string, startsMidFile = false): WorkerEvent[] {
  return parseEvents(source, startsMidFile);
}
