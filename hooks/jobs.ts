import type {
  DshActivity,
  DshAlert,
  DshAlertKind,
  DshJob,
  DshJobView,
  DshStatusDisplay,
  DshStatusTone,
  DshToolCount,
  DshUsage,
  DshWorktree,
} from '../types'

/**
 * Pure DSH job logic: normalization, status mapping, event parsing, activity
 * derivation, filtering, sorting, grouping and formatting.
 *
 * This module deliberately touches no engine noun: it has no `$`, does no I/O
 * and is unit-tested directly by `tests/pane.test.tsx`.
 */

const JOB_ID = /^[A-Za-z0-9_-]+$/

const ALERT_KINDS = new Set<DshAlertKind>([
  'stalled',
  'loop',
  'tool_errors',
  'budget',
])

/** Statuses that mean the MCP still owns the job. */
const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running'])

/** Statuses that mean the model loop is actually working. */
const RUNNING_STATUSES = new Set(['starting', 'running'])

/** Terminal rows shown at once; active rows are never limited. */
export const TERMINAL_LIMIT = 30

/** Activity rows shown for an expanded job. */
export const ACTIVITY_LIMIT = 8

/** Tool-count rows shown for an expanded job. */
export const TOOL_COUNT_LIMIT = 5

/** `events.ndjson` is skipped past this size (the MCP keeps appending). */
export const EVENTS_MAX_BYTES = 3.5 * 1024 * 1024

/** `final.md` is skipped past this size. */
export const FINAL_MAX_BYTES = 1024 * 1024

/** Lines of `final.md` an expanded succeeded row shows before `more`. */
export const FINAL_LINES = 14

/** Hard cap on the lines of `final.md` the pane keeps in memory. */
export const FINAL_MAX_LINES = 200

/** Lines of `stderrTail` an expanded failed row shows. */
export const STDERR_LINES = 3

/** Lines of `errorMessage` an expanded failed row shows. */
export const ERROR_LINES = 4

/** Lines of the last assistant `text` event the pane shows. */
export const SAYS_LINES = 3

/** A running job whose last event is older than this is called stalled. */
export const STALE_EVENT_MS = 90_000

/** The last assistant text event is kept to this many characters in state. */
export const LAST_TEXT_MAX_CHARS = 4000

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmptyText(value: unknown): string | undefined {
  const found = text(value)
  return found !== undefined && found.trim() !== '' ? found : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Whether a directory entry name is a legal DSH job id. */
export function isJobId(value: string): boolean {
  return JOB_ID.test(value)
}

function normalizeWorktree(value: unknown): DshWorktree | undefined {
  if (!isRecord(value)) return undefined
  const worktree: DshWorktree = {}
  const path = nonEmptyText(value.path)
  const branch = nonEmptyText(value.branch)
  const baseCommit = nonEmptyText(value.baseCommit)
  const repoRoot = nonEmptyText(value.repoRoot)
  const cleaned = flag(value.cleaned)
  if (path !== undefined) worktree.path = path
  if (branch !== undefined) worktree.branch = branch
  if (baseCommit !== undefined) worktree.baseCommit = baseCommit
  if (repoRoot !== undefined) worktree.repoRoot = repoRoot
  if (cleaned !== undefined) worktree.cleaned = cleaned
  return Object.keys(worktree).length === 0 ? undefined : worktree
}

function normalizeUsage(value: unknown): DshUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage: DshUsage = {}
  const fields = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const
  for (const field of fields) {
    const found = count(value[field])
    if (found !== undefined) usage[field] = found
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

/** Normalize the persisted watchdog alerts, dropping malformed entries. */
function normalizeAlerts(value: unknown): DshAlert[] {
  if (!Array.isArray(value)) return []
  const alerts: DshAlert[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const kind = nonEmptyText(entry.kind)
    const message = nonEmptyText(entry.message)
    if (
      kind === undefined ||
      message === undefined ||
      !ALERT_KINDS.has(kind as DshAlertKind)
    ) {
      continue
    }
    const since = nonEmptyText(entry.since)
    alerts.push({
      kind: kind as DshAlertKind,
      message,
      ...(since !== undefined ? { since } : {}),
    })
  }
  return alerts
}

/** `⚠ loop · same bash call repeated 5× · ⚠ budget · ...` for one row. */
export function alertsLine(alerts: readonly DshAlert[]): string {
  return alerts.map(alert => `⚠ ${alert.kind} · ${alert.message}`).join(' · ')
}

/**
 * Normalize one parsed `job.json` value. `fallbackId` is the directory's id:
 * the directory is canonical, so a missing or malformed `id` falls back to it.
 * Returns `null` only when the value is not an object at all.
 */
export function normalizeJob(
  value: unknown,
  fallbackId: string,
): DshJob | null {
  if (!isRecord(value)) return null

  const parsedId = nonEmptyText(value.id)
  const id = isJobId(fallbackId)
    ? fallbackId
    : parsedId !== undefined && isJobId(parsedId)
      ? parsedId
      : 'unknown'

  const label = nonEmptyText(value.label) ?? id
  const status = nonEmptyText(value.status) ?? 'unknown'
  const job: DshJob = {
    id,
    label,
    status,
    stderrTail: text(value.stderrTail) ?? '',
    alerts: normalizeAlerts(value.alerts),
  }

  const stringFields = [
    'groupId',
    'groupName',
    'ownerId',
    'cwd',
    'access',
    'isolation',
    'reason',
    'errorMessage',
    'createdAt',
    'startedAt',
    'finishedAt',
    'lastTool',
    'turnEndKind',
    'profile',
    'provider',
    'model',
  ] as const
  for (const field of stringFields) {
    const found = nonEmptyText(value[field])
    if (found !== undefined) job[field] = found
  }

  const numberFields = [
    'malformedLines',
    'eventsCount',
    'toolCalls',
    'steps',
  ] as const
  for (const field of numberFields) {
    const found = count(value[field])
    if (found !== undefined) job[field] = found
  }

  const cost = numeric(value.costUsd)
  if (cost !== undefined) job.costUsd = cost

  const worktree = normalizeWorktree(value.worktree)
  if (worktree !== undefined) job.worktree = worktree

  const usage = normalizeUsage(value.usage)
  if (usage !== undefined) job.usage = usage

  return job
}

/** Parse `job.json` text; malformed or truncated JSON resolves to `null`. */
export function parseJobJson(
  source: string,
  fallbackId: string,
): DshJob | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return null
  }
  return normalizeJob(parsed, fallbackId)
}

/** Whether `status` is one the MCP may still be writing. */
export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status)
}

/** Whether `status` means the model loop is working right now. */
export function isRunningStatus(status: string): boolean {
  return RUNNING_STATUSES.has(status)
}

/**
 * Remove control characters and collapse whitespace so an untrusted raw value
 * (a status, a label, a log line) can never break the pane's layout.
 */
export function sanitizeLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Map a raw `job.json` status to the pane's label, tone and liveness. */
export function statusDisplay(status: string): DshStatusDisplay {
  switch (status) {
    case 'queued':
      return {
        label: '○ QUEUED',
        tone: 'inactive',
        isActive: true,
        isTerminal: false,
      }
    case 'starting':
    case 'running':
      return {
        label: '◌ RUNNING',
        tone: 'claude',
        isActive: true,
        isTerminal: false,
      }
    case 'succeeded':
      return {
        label: '✓ SUCCEEDED',
        tone: 'success',
        isActive: false,
        isTerminal: true,
      }
    case 'failed':
      return {
        label: '✗ FAILED',
        tone: 'error',
        isActive: false,
        isTerminal: true,
      }
    case 'timed_out':
      return {
        label: '✗ TIMED_OUT',
        tone: 'error',
        isActive: false,
        isTerminal: true,
      }
    case 'cancelled':
      return {
        label: '− CANCELLED',
        tone: 'inactive',
        isActive: false,
        isTerminal: true,
      }
    case 'interrupted':
      return {
        label: '⚠ INTERRUPTED',
        tone: 'warning',
        isActive: false,
        isTerminal: true,
      }
    default: {
      const raw = truncateLine(sanitizeLine(status), 32) || 'unknown'
      return {
        label: `? ${raw}`,
        tone: 'subtle',
        isActive: false,
        isTerminal: true,
      }
    }
  }
}

/**
 * Parse `events.ndjson`: one JSON object per line. Invalid lines, including a
 * partial last line while the MCP is appending, are ignored.
 */
export function parseEventLines(source: string): UnknownRecord[] {
  const events: UnknownRecord[] = []
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) events.push(parsed)
    } catch {
      // A partial or malformed line is expected: the file is appended live.
    }
  }
  return events
}

const SUMMARY_FIELDS = [
  'command',
  'description',
  'file_path',
  'pattern',
  'path',
] as const

/** The one-line summary of a tool call's `input`, in the documented order. */
export function activitySummary(input: unknown): string {
  if (!isRecord(input)) return ''
  for (const field of SUMMARY_FIELDS) {
    const found = nonEmptyText(input[field])
    if (found !== undefined) return truncateLine(sanitizeLine(found), 120)
  }
  return ''
}

/** Everything the pane derives from one `events.ndjson` read. */
export type DshEventDerivation = {
  activity: DshActivity[]
  toolCounts: DshToolCount[]
  lastText?: string
  lastError?: string
}

/**
 * Derive activity, tool counts and the last assistant text / error in one pass
 * over the parsed events. `tool_result` events are indexed first in the same
 * pass so each `tool_call` gets its final glyph without a second walk.
 */
export function deriveJobEvents(
  events: readonly UnknownRecord[],
): DshEventDerivation {
  const results = new Map<string, string>()
  const calls: DshActivity[] = []
  const counts = new Map<string, number>()
  let lastText: string | undefined
  let lastError: string | undefined

  for (const event of events) {
    switch (event.type) {
      case 'tool_result': {
        const callId = nonEmptyText(event.callId)
        if (callId === undefined) break
        results.set(callId, nonEmptyText(event.status) ?? 'unknown')
        break
      }
      case 'tool_call': {
        const callId = nonEmptyText(event.callId)
        const tool = nonEmptyText(event.tool)
        if (callId === undefined || tool === undefined) break
        calls.push({
          callId,
          tool,
          summary: activitySummary(event.input),
          glyph: '◌',
        })
        counts.set(tool, (counts.get(tool) ?? 0) + 1)
        break
      }
      case 'text': {
        const found = nonEmptyText(event.text)
        if (found !== undefined) {
          lastText = found.trim().slice(0, LAST_TEXT_MAX_CHARS)
        }
        break
      }
      case 'error': {
        const found = nonEmptyText(event.message)
        if (found !== undefined) lastError = found.trim()
        break
      }
      default:
        break
    }
  }

  for (const call of calls) {
    const result = results.get(call.callId)
    call.glyph =
      result === undefined ? '◌' : result === 'completed' ? '✓' : '✗'
  }

  const toolCounts = [...counts]
    .map(([tool, toolCount]) => ({ tool, count: toolCount }))
    .sort(
      (left, right) =>
        right.count - left.count || left.tool.localeCompare(right.tool),
    )
    .slice(0, TOOL_COUNT_LIMIT)

  const derivation: DshEventDerivation = {
    activity: calls.slice(-ACTIVITY_LIMIT),
    toolCounts,
  }
  if (lastText !== undefined) derivation.lastText = lastText
  if (lastError !== undefined) derivation.lastError = lastError
  return derivation
}

/** Derive from parsed records, retaining the old activity-only entry point. */
export function deriveActivity(
  events: readonly UnknownRecord[],
): DshActivity[] {
  return deriveJobEvents(events).activity
}

/** Parse and derive everything in one step, for a whole `events.ndjson` read. */
export function jobEventsFromSource(source: string): DshEventDerivation {
  return deriveJobEvents(parseEventLines(source))
}

/** Parse and derive activity in one step, for a whole events read. */
export function activityFromEvents(source: string): DshActivity[] {
  return jobEventsFromSource(source).activity
}

/** Normalize a path for containment checks (both separators, no trailing /). */
export function normalizePath(value: string): string {
  let normalized = value.replace(/\\/g, '/')
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/** True when `path` is `root` itself or lies beneath it. */
export function isSameOrInside(path: string, root: string): boolean {
  const target = normalizePath(path)
  const base = normalizePath(root)
  if (target === '' || base === '') return false
  if (target === base) return true
  return target.startsWith(base === '/' ? '/' : `${base}/`)
}

/**
 * Default project filter: a worktree job belongs through `worktree.repoRoot`
 * (its `cwd` is the worktree path); any other job through its own `cwd`.
 * A path belongs when it equals the session cwd or is inside it.
 */
export function belongsToProject(
  job: Pick<DshJob, 'cwd' | 'worktree'>,
  projectCwd: string,
): boolean {
  const target = job.worktree?.repoRoot ?? job.cwd
  return target !== undefined && isSameOrInside(target, projectCwd)
}

function createdAtMs(job: Pick<DshJob, 'createdAt'>): number {
  if (job.createdAt === undefined) return 0
  const parsed = Date.parse(job.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Active first, then newest `createdAt`; stable by id on a tie. */
export function sortJobs<T extends Pick<DshJob, 'id' | 'status' | 'createdAt'>>(
  jobs: readonly T[],
): T[] {
  return [...jobs].sort((left, right) => {
    const leftActive = isActiveStatus(left.status) ? 1 : 0
    const rightActive = isActiveStatus(right.status) ? 1 : 0
    if (leftActive !== rightActive) return rightActive - leftActive
    return (
      createdAtMs(right) - createdAtMs(left) ||
      left.id.localeCompare(right.id)
    )
  })
}

export type VisibleJobsOptions = {
  showAll: boolean
  projectCwd: string
  terminalLimit?: number
}

/**
 * Filter, sort and cap a job list: all jobs with `showAll`, otherwise this
 * project's; active jobs first, then newest, with at most 30 terminal rows.
 */
export function visibleJobs<T extends Pick<DshJob, 'id' | 'status' | 'createdAt' | 'cwd' | 'worktree'>>(
  jobs: readonly T[],
  options: VisibleJobsOptions,
): T[] {
  const filtered = options.showAll
    ? [...jobs]
    : jobs.filter(job => belongsToProject(job, options.projectCwd))
  const sorted = sortJobs(filtered)
  const limit = options.terminalLimit ?? TERMINAL_LIMIT
  let terminal = 0
  return sorted.filter(job => {
    if (isActiveStatus(job.status)) return true
    terminal += 1
    return terminal <= limit
  })
}

export type JobGroup<T> = { name: string; jobs: T[] }

/** Group rows by `groupName` (for the all-jobs mode), keeping sorted order. */
export function groupJobs<T extends Pick<DshJob, 'groupName'>>(
  jobs: readonly T[],
): JobGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const job of jobs) {
    const name = nonEmptyText(job.groupName) ?? 'Other'
    const rows = groups.get(name)
    if (rows === undefined) groups.set(name, [job])
    else rows.push(job)
  }
  return [...groups].map(([name, rows]) => ({ name, jobs: rows }))
}

/**
 * The header's summary segments, in status order. Zero segments are omitted;
 * an empty list means there are no visible rows (`idle`).
 */
export type DshSummarySegment = {
  key:
    | 'running'
    | 'queued'
    | 'succeeded'
    | 'failed'
    | 'interrupted'
    | 'cancelled'
    | 'other'
  text: string
  tone: DshStatusTone
  count: number
}

export function summarySegments(
  jobs: readonly Pick<DshJob, 'status'>[],
): DshSummarySegment[] {
  let running = 0
  let queued = 0
  let succeeded = 0
  let failed = 0
  let interrupted = 0
  let cancelled = 0
  let other = 0

  for (const job of jobs) {
    switch (job.status) {
      case 'starting':
      case 'running':
        running += 1
        break
      case 'queued':
        queued += 1
        break
      case 'succeeded':
        succeeded += 1
        break
      case 'failed':
      case 'timed_out':
        failed += 1
        break
      case 'interrupted':
        interrupted += 1
        break
      case 'cancelled':
        cancelled += 1
        break
      default:
        other += 1
        break
    }
  }

  const segments: DshSummarySegment[] = []
  const add = (
    key: DshSummarySegment['key'],
    label: string,
    segmentCount: number,
    tone: DshStatusTone,
  ) => {
    if (segmentCount === 0) return
    segments.push({
      key,
      text: `${label} ${segmentCount}`,
      tone,
      count: segmentCount,
    })
  }
  add('running', '◌', running, 'claude')
  add('queued', '○', queued, 'inactive')
  add('succeeded', '✓', succeeded, 'success')
  add('failed', '✗', failed, 'error')
  add('interrupted', '⚠', interrupted, 'warning')
  add('cancelled', '−', cancelled, 'inactive')
  add('other', '?', other, 'subtle')

  // Running, queued and the rarer terminal states read as words; the common
  // succeeded/failed counts are compact glyphs alone.
  const words = new Set([
    'running',
    'queued',
    'interrupted',
    'cancelled',
    'other',
  ])
  return segments.map(segment =>
    words.has(segment.key)
      ? { ...segment, text: `${segment.text} ${segment.key}` }
      : segment,
  )
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Elapsed milliseconds for a row, or undefined without a start. */
export function elapsedMs(
  job: Pick<DshJob, 'status' | 'createdAt' | 'startedAt' | 'finishedAt'>,
  nowMs: number,
): number | undefined {
  const start = timestamp(job.startedAt) ?? timestamp(job.createdAt)
  if (start === undefined) return undefined
  const finished = timestamp(job.finishedAt)
  const end = finished ?? (isActiveStatus(job.status) ? nowMs : undefined)
  if (end === undefined) return undefined
  return Math.max(0, end - start)
}

/** A compact duration: `0s`, `45s`, `3m12s`, `1h04m`. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0
      ? `${minutes}m`
      : `${minutes}m${String(rest).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}m`
}

/** A compact token count: `812`, `81.6k`, `2.5M`. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const tokens = Math.max(0, Math.floor(value))
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) {
    const scaled = Math.round((tokens / 1000) * 10) / 10
    return `${scaled.toFixed(scaled % 1 === 0 ? 0 : 1)}k`
  }
  const scaled = Math.round((tokens / 1_000_000) * 10) / 10
  return `${scaled.toFixed(scaled % 1 === 0 ? 0 : 1)}M`
}

/**
 * The collapsed meta line: `model · duration · $cost · N steps · N tools`.
 * Every missing value is skipped; an empty string means show no meta line.
 */
export function jobMetaLine(
  job: Pick<
    DshJob,
    | 'model'
    | 'status'
    | 'createdAt'
    | 'startedAt'
    | 'finishedAt'
    | 'costUsd'
    | 'steps'
    | 'toolCalls'
  >,
  nowMs: number,
): string {
  const parts: string[] = []
  if (job.model !== undefined) parts.push(job.model)
  const elapsed = elapsedMs(job, nowMs)
  if (elapsed !== undefined) parts.push(formatDuration(elapsed))
  const cost = formatCost(job.costUsd)
  if (cost !== undefined) parts.push(cost)
  if (job.steps !== undefined) parts.push(`${job.steps} steps`)
  if (job.toolCalls !== undefined) parts.push(`${job.toolCalls} tools`)
  return parts.join(' · ')
}

/** `$0.09`, `<$0.01`, or undefined when there is no cost. */
export function formatCost(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return undefined
  if (costUsd > 0 && costUsd < 0.01) return '<$0.01'
  return `$${Math.max(0, costUsd).toFixed(2)}`
}

/** cacheRead / (input + cacheRead) as a rounded percentage. */
export function cacheHitPercent(usage: DshUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  const read = usage.cacheReadTokens
  const input = usage.inputTokens
  if (read === undefined || input === undefined) return undefined
  const denominator = input + read
  if (denominator <= 0) return undefined
  return Math.max(0, Math.min(100, Math.round((read / denominator) * 100)))
}

/** `just now`, `3s ago`, `2m ago`, `1h ago`, `2d ago`. */
export function formatAgo(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 1) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Age of `events.ndjson` at the refresh's clock time. */
export function eventsAgeMs(
  job: { eventsMtimeMs?: number },
  nowMs: number,
): number | undefined {
  if (job.eventsMtimeMs === undefined) return undefined
  return Math.max(0, nowMs - job.eventsMtimeMs)
}

/** Whether a running job has not written an event for `STALE_EVENT_MS`. */
export function isStalledRunning(
  job: Pick<DshJob, 'status'> & { eventsMtimeMs?: number },
  nowMs: number,
): boolean {
  if (!isRunningStatus(job.status)) return false
  const age = eventsAgeMs(job, nowMs)
  return age !== undefined && age > STALE_EVENT_MS
}

/** The total tokens a usage object represents, when any are known. */
export function usageTokens(usage: DshUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  if (usage.totalTokens !== undefined) return usage.totalTokens
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  }
  return undefined
}

/** Sum the visible rows' costs, or undefined when no row has one. */
export function totalCost(
  jobs: readonly Pick<DshJob, 'costUsd'>[],
): number | undefined {
  let total: number | undefined
  for (const job of jobs) {
    if (job.costUsd === undefined) continue
    total = (total ?? 0) + job.costUsd
  }
  return total
}

/** Sum the visible rows' tokens, or undefined when no row has a usage. */
export function totalTokens(
  jobs: readonly Pick<DshJob, 'usage'>[],
): number | undefined {
  let total: number | undefined
  for (const job of jobs) {
    const tokens = usageTokens(job.usage)
    if (tokens === undefined) continue
    total = (total ?? 0) + tokens
  }
  return total
}

/** The most recent visible job by `createdAt`, keeping the first on a tie. */
export function newestJob<T extends Pick<DshJob, 'createdAt'>>(
  jobs: readonly T[],
): T | undefined {
  let newest: T | undefined
  for (const job of jobs) {
    if (newest === undefined || createdAtMs(job) > createdAtMs(newest)) {
      newest = job
    }
  }
  return newest
}

/** `profile-or-provider · model`, or one of them when only one exists. */
export function jobIdentity(
  job: Pick<DshJob, 'profile' | 'provider' | 'model'>,
): string | undefined {
  const parts: string[] = []
  const server = job.profile ?? job.provider
  if (server !== undefined) parts.push(server)
  if (job.model !== undefined) parts.push(job.model)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** `bash 54 · read 20 · edit 8 · grep 6`, top N only. */
export function toolCountsLine(
  counts: readonly DshToolCount[],
): string {
  return counts
    .slice(0, TOOL_COUNT_LIMIT)
    .map(entry => `${entry.tool} ${entry.count}`)
    .join(' · ')
}

/** The access badge in the details section. */
export function accessDisplay(access: string): {
  label: string
  tone: DshStatusTone
} {
  if (access === 'read-only') return { label: 'read-only', tone: 'success' }
  if (access === 'workspace-write') return { label: 'write', tone: 'warning' }
  return { label: access, tone: 'subtle' }
}

/** `worktree` or `in-place`, from the job's isolation / worktree data. */
export function isolationDisplay(
  job: Pick<DshJob, 'isolation' | 'worktree'>,
): string | undefined {
  if (job.isolation === 'worktree' || job.worktree !== undefined) {
    return 'worktree'
  }
  if (job.isolation === 'none') return 'in-place'
  return job.isolation
}

/** `dsh/j_1 @ cc9791b`, with `(cleaned)` when the worktree was removed. */
export function branchLine(worktree: DshWorktree | undefined): string | undefined {
  if (worktree?.branch === undefined) return undefined
  const base =
    worktree.baseCommit !== undefined
      ? ` @ ${worktree.baseCommit.slice(0, 7)}`
      : ''
  const cleaned = worktree.cleaned === true ? ' (cleaned)' : ''
  return `${worktree.branch}${base}${cleaned}`
}

/** Local `HH:MM:SS` from an ISO timestamp, when it parses. */
export function formatTimestamp(value: string | undefined): string | undefined {
  const milliseconds = timestamp(value)
  return milliseconds === undefined ? undefined : formatClockTime(milliseconds)
}

/** Local `HH:MM:SS` for the footer, from `$.clock.now()` milliseconds. */
export function formatClockTime(milliseconds: number): string {
  const date = new Date(milliseconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Truncate a single line to `columns` cells, marking a cut with `…`. */
export function truncateLine(value: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns))
  if (width === 0) return ''
  const characters = Array.from(value)
  if (characters.length <= width) return value
  if (width === 1) return '…'
  return `${characters.slice(0, width - 1).join('')}…`
}

/** Truncate every line of a multi-line text, preserving its line breaks. */
export function truncateLines(value: string, columns: number): string {
  return value
    .split(/\r?\n/)
    .map(line => truncateLine(line, columns))
    .join('\n')
}

/** The last `limit` non-empty lines of a text, each trimmed at the end. */
export function lastNonEmptyLines(source: string, limit: number): string[] {
  return source
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-Math.max(0, limit))
}

/** The first `limit` non-empty lines of a text. */
export function firstNonEmptyLines(source: string, limit: number): string[] {
  return source
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(0, Math.max(0, limit))
}

/** Join path parts with `/`, tolerating trailing separators on each part. */
export function joinPath(...parts: readonly string[]): string {
  let result = ''
  for (const part of parts) {
    if (part === '') continue
    if (result === '') {
      result = part
      continue
    }
    const left = result.endsWith('/') ? result.slice(0, -1) : result
    const right = part.startsWith('/') ? part.slice(1) : part
    result = `${left}/${right}`
  }
  return result
}

export type StateDirSources = {
  option?: string | undefined
  dedicated?: string | undefined
  xdgStateHome?: string | undefined
  home?: string | undefined
}

/**
 * Resolve the DSH state directory, first match wins:
 * the `stateDir` option, `$DSH_WORKERS_STATE_DIR`, `$XDG_STATE_HOME/dsh-workers`,
 * `$HOME/.local/state/dsh-workers`.
 */
export function resolveStateDir(sources: StateDirSources): string {
  const option = nonEmptyText(sources.option)
  if (option !== undefined) return option
  const dedicated = nonEmptyText(sources.dedicated)
  if (dedicated !== undefined) return dedicated
  const xdg = nonEmptyText(sources.xdgStateHome)
  if (xdg !== undefined) return joinPath(xdg, 'dsh-workers')
  const home = nonEmptyText(sources.home)
  if (home !== undefined) return joinPath(home, '.local/state/dsh-workers')
  return '.local/state/dsh-workers'
}

/**
 * The pane background from the `pane_background` option: a `#rrggbb` hex
 * color, or undefined (blank or anything else) to keep Claude Code's own fill.
 */
export function paneBackground(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined
}

/** The rows of a job that are worth re-reading only when their mtime moves. */
export type JobCacheEntry = {
  jobSeenMtimeMs?: number
  job?: DshJob
  invalid?: boolean
  eventsSeenMtimeMs?: number
  eventsMtimeMs?: number
  activity?: DshActivity[]
  activityTooLarge?: boolean
  toolCounts?: DshToolCount[]
  lastText?: string
  lastError?: string
  finalSeenMtimeMs?: number
  finalText?: string
  finalTooLarge?: boolean
}

/** Build the view row handed to the renderer from a cache entry. */
export function toJobView(job: DshJob, entry: JobCacheEntry): DshJobView {
  const view: DshJobView = {
    ...job,
    activity: entry.activity ?? [],
    toolCounts: entry.toolCounts ?? [],
  }
  if (entry.activityTooLarge === true) view.activityTooLarge = true
  if (entry.lastText !== undefined) view.lastText = entry.lastText
  if (entry.lastError !== undefined) view.lastError = entry.lastError
  if (entry.eventsMtimeMs !== undefined) view.eventsMtimeMs = entry.eventsMtimeMs
  if (entry.finalText !== undefined) view.finalText = entry.finalText
  if (entry.finalTooLarge === true) view.finalTooLarge = true
  return view
}
