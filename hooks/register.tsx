import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  FsEntry,
  McpToolResult,
  PluginOptions,
  Register,
  RenderElement,
} from 'claude-code'

import type {
  DshActionKind,
  DshActionResult,
  DshActionResults,
  DshJobView,
  DshPaneView,
  DshPendingAction,
  DshStatusTone,
} from '../types'
import {
  accessDisplay,
  alertsLine,
  branchLine,
  cacheHitPercent,
  elapsedMs,
  ERROR_LINES,
  EVENTS_MAX_BYTES,
  eventsAgeMs,
  FINAL_LINES,
  FINAL_MAX_BYTES,
  FINAL_MAX_LINES,
  firstNonEmptyLines,
  formatAgo,
  formatClockTime,
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  groupJobs,
  isActiveStatus,
  isJobId,
  isRunningStatus,
  isStalledRunning,
  isolationDisplay,
  jobEventsFromSource,
  jobIdentity,
  jobMetaLine,
  joinPath,
  lastNonEmptyLines,
  newestJob,
  parseJobJson,
  paneBackground,
  resolveStateDir,
  sanitizeLine,
  SAYS_LINES,
  STDERR_LINES,
  statusDisplay,
  summarySegments,
  toJobView,
  toolCountsLine,
  totalCost,
  totalTokens,
  truncateLine,
  truncateLines,
  usageTokens,
  visibleJobs,
  type JobCacheEntry,
} from './jobs'

const PANE_ID = 'agent-workers'
const REFRESH_MS = 1000
const PANE_COLUMNS = 58

const EMPTY_VIEW: DshPaneView = {
  isLoaded: false,
  jobs: [],
  stateDir: '',
  jobsDir: '',
  projectCwd: '',
  updatedAtMs: null,
}

// $.state survives a hot reload; module variables below do not. The cache is
// only an optimization, so losing it and re-reading on a reload is harmless.
const viewRef = { plugin: 'agent-workers', key: 'view' } as const
const viewAtom = atom(viewRef, EMPTY_VIEW)
const expandedAtom = atom(
  { plugin: 'agent-workers', key: 'expanded' } as const,
  [] as string[],
)
const finalExpandedAtom = atom(
  { plugin: 'agent-workers', key: 'finalExpanded' } as const,
  [] as string[],
)
const showAllAtom = atom(
  { plugin: 'agent-workers', key: 'showAll' } as const,
  false,
)
const pendingRef = { plugin: 'agent-workers', key: 'pendingAction' } as const
const pendingActionAtom = atom(pendingRef, null as DshPendingAction | null)
const actionResultsRef = {
  plugin: 'agent-workers',
  key: 'actionResults',
} as const
const actionResultsAtom = atom(actionResultsRef, {} as DshActionResults)

const PLUGIN_SERVER = 'agent-workers'
const CONFIRM_MS = 5000
const ACTION_TEXT_MAX = 120

let cache = new Map<string, JobCacheEntry>()
let inFlight = false
let stateDir = ''
let startCwd = ''
let tick: { cancel: () => void } | undefined
let resolvedServer: string | undefined

/** The plugin-qualified server names a session may expose this plugin as. */
function serverCandidates(): string[] {
  return [
    `plugin:${PLUGIN_SERVER}:${PLUGIN_SERVER}`,
    `plugin_${PLUGIN_SERVER}_${PLUGIN_SERVER}`,
    PLUGIN_SERVER,
  ]
}

/** `mcp__plugin_agent-workers_agent-workers__worker_delete` → the server segment. */
function serverFromToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const end = name.lastIndexOf('__worker_')
  if (end <= 'mcp__'.length) return undefined
  return name.slice('mcp__'.length, end)
}

/**
 * Resolve the MCP server the plugin ships. `$.mcp.connect` knows the manifest
 * server key and answers the name the session uses, which is the robust path
 * when the plugin namespaces the server. `$.tool.list` is the fallback when a
 * session already connected the server under another name. The answer is
 * cached; a failed resolution stays retryable.
 */
async function resolveMcpServer($: EngineInterface): Promise<string | undefined> {
  if (resolvedServer !== undefined) return resolvedServer
  try {
    const connected = await $.mcp.connect(PLUGIN_SERVER)
    if (connected.isConnected) {
      resolvedServer = connected.server
      return resolvedServer
    }
  } catch {
    // Fall through to the connected-tool listing.
  }
  try {
    const tools = await $.tool.list()
    for (const tool of tools) {
      if (!tool.mcp) continue
      if (
        !tool.name.endsWith('__worker_delete') &&
        !tool.name.endsWith('__worker_cleanup') &&
        !tool.name.endsWith('__worker_status')
      ) {
        continue
      }
      const server = serverFromToolName(tool.name)
      if (server !== undefined) {
        resolvedServer = server
        return resolvedServer
      }
    }
  } catch {
    // The call below still tries the plausible names.
  }
  return undefined
}

/** Call one dsh tool, trying the resolved name and then the plausible ones. */
async function callDshTool(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const preferred = await resolveMcpServer($)
  const candidates = [
    ...(preferred === undefined ? [] : [preferred]),
    ...serverCandidates().filter(server => server !== preferred),
  ]
  let lastError: unknown
  for (const server of candidates) {
    try {
      const result = await $.mcp.call(server, tool, args)
      resolvedServer = server
      return result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('agent-workers MCP server is not connected')
}

type ParsedToolResult = {
  data?: Record<string, unknown>
  isError: boolean
  text: string
}

function parseToolResult(result: McpToolResult): ParsedToolResult {
  const text = result.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
  let data: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
  } catch {
    // A non-JSON text result is still shown, truncated, as the error.
  }
  return { data, isError: result.isError === true, text }
}

type ActionOutcome = {
  kind: 'deleted' | 'cleaned' | 'dirty' | 'error'
  text: string
}

function outcomeMessage(parsed: ParsedToolResult): string {
  const message = parsed.data?.message
  if (typeof message === 'string' && message.trim() !== '') return message
  const error = parsed.data?.error
  if (typeof error === 'string' && error.trim() !== '') return error
  return parsed.text === '' ? 'action failed' : parsed.text
}

function classifyOutcome(
  result: McpToolResult,
  action: DshActionKind,
): ActionOutcome {
  const parsed = parseToolResult(result)
  if (
    parsed.data?.error === 'worktree_dirty' ||
    parsed.data?.worktree === 'preserved_dirty'
  ) {
    return { kind: 'dirty', text: 'worktree has changes' }
  }
  if (parsed.isError || parsed.data?.error !== undefined) {
    return { kind: 'error', text: outcomeMessage(parsed) }
  }
  return {
    kind: action === 'delete' ? 'deleted' : 'cleaned',
    text: action === 'delete' ? 'deleted' : 'cleaned',
  }
}

async function storeResult(
  $: EngineInterface,
  jobId: string,
  action: DshActionKind,
  outcome: ActionOutcome,
): Promise<void> {
  const now = await $.clock.now()
  const result: DshActionResult = {
    action,
    kind: outcome.kind,
    text: truncateLine(outcome.text, ACTION_TEXT_MAX),
    tone:
      outcome.kind === 'dirty'
        ? 'warning'
        : outcome.kind === 'error'
          ? 'error'
          : 'success',
    atMs: now,
  }
  if (outcome.kind === 'dirty') result.needsDiscard = true
  const results = await read($, actionResultsAtom)
  await $.state.set(actionResultsRef, { ...results, [jobId]: result })
}

async function clearPending($: EngineInterface, jobId: string): Promise<void> {
  const pending = await read($, pendingActionAtom)
  if (pending === null || pending.jobId !== jobId) return
  await $.state.set(pendingRef, null)
}

async function runAction(
  $: EngineInterface,
  job: DshJobView,
  action: DshActionKind,
  discardChanges: boolean,
): Promise<void> {
  const tool = action === 'delete' ? 'worker_delete' : 'worker_cleanup'
  let outcome: ActionOutcome
  try {
    const result = await callDshTool($, tool, {
      job_id: job.id,
      discard_changes: discardChanges,
    })
    outcome = classifyOutcome(result, action)
  } catch (error) {
    outcome = { kind: 'error', text: describeError(error) }
  }
  await storeResult($, job.id, action, outcome)
  await clearPending($, job.id)
}

/**
 * One press arms a confirm for five seconds; a second press inside that window
 * runs the tool. `stage` is `discard` for the second, destructive confirmation
 * after the server reports a dirty worktree. Nothing is called on one press.
 */
async function pressAction(
  $: EngineInterface,
  job: DshJobView,
  action: DshActionKind,
  stage: 'confirm' | 'discard',
): Promise<void> {
  const now = await $.clock.now()
  const pending = await read($, pendingActionAtom)
  const isArmed =
    pending !== null &&
    pending.jobId === job.id &&
    pending.action === action &&
    pending.stage === stage &&
    now < pending.expiresAtMs
  if (isArmed) {
    await $.state.set(pendingRef, null)
    await runAction($, job, action, stage === 'discard')
    return
  }
  await $.state.set(pendingRef, {
    jobId: job.id,
    action,
    stage,
    expiresAtMs: now + CONFIRM_MS,
  })
}

function describeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error'
  const clean = message
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateLine(clean === '' ? 'unknown error' : clean, 160)
}

/** Resolve the configured state dir, first match wins. */
async function resolveStateDirFor(
  $: EngineInterface,
  options: PluginOptions,
): Promise<string> {
  const rawOption = typeof options.state_dir === 'string' ? options.state_dir : undefined
  const option = rawOption?.trim() ? rawOption.trim() : undefined
  const rawDedicated =
    (await $.env.get('AGENT_WORKERS_STATE_DIR')) ??
    (await $.env.get('DSH_WORKERS_STATE_DIR'))
  const dedicated = rawDedicated?.trim() ? rawDedicated.trim() : undefined
  const xdgStateHome = await $.env.get('XDG_STATE_HOME')
  const home = await $.env.get('HOME')

  if (option !== undefined || dedicated !== undefined) {
    return resolveStateDir({ option, dedicated, xdgStateHome, home })
  }

  const current = resolveStateDir({ xdgStateHome, home })
  if (await pathExists($, current)) return current
  const legacy = resolveStateDir({ xdgStateHome, home, legacy: true })
  if (await pathExists($, legacy)) return legacy
  return current
}

async function projectCwd($: EngineInterface): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return startCwd
  }
}

async function pathExists($: EngineInterface, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Write the view only when it changed. A `$.state` write redraws every
 * `ui.render` instance that read the atom, so no `$.ui.invalidate` call is
 * needed here (it is for cached render answers, not for state changes).
 */
async function writeView($: EngineInterface, next: DshPaneView): Promise<void> {
  const current = await read($, viewAtom)
  if (JSON.stringify(current) === JSON.stringify(next)) return
  await $.state.set(viewRef, next)
}

/** Record a short warning without dropping whatever the pane last showed. */
async function recordWarning($: EngineInterface, error: unknown): Promise<void> {
  try {
    const current = await read($, viewAtom)
    const warning = `refresh failed: ${describeError(error)}`
    if (current.warning === warning) return
    await $.state.set(viewRef, { ...current, warning })
  } catch {
    // Nothing else to do: never let a timer's failure escape.
  }
}

/**
 * Read `events.ndjson` for an active job or an expanded row. Terminal rows
 * are read once: their events do not change, so the mtime check skips them.
 */
async function readEvents(
  $: EngineInterface,
  dir: string,
  entry: JobCacheEntry,
  warnings: string[],
): Promise<void> {
  const eventsPath = joinPath(dir, 'events.ndjson')
  try {
    const stat = await $.fs.stat(eventsPath)
    entry.eventsMtimeMs = stat.mtimeMs
    if (stat.size > EVENTS_MAX_BYTES) {
      entry.activity = []
      entry.toolCounts = []
      entry.lastText = undefined
      entry.lastError = undefined
      entry.activityTooLarge = true
      entry.eventsSeenMtimeMs = stat.mtimeMs
      return
    }
    if (entry.eventsSeenMtimeMs === stat.mtimeMs) return
    entry.eventsSeenMtimeMs = stat.mtimeMs
    try {
      const source = await $.fs.read(eventsPath)
      const derived = jobEventsFromSource(source)
      entry.activity = derived.activity
      entry.toolCounts = derived.toolCounts
      entry.lastText = derived.lastText
      entry.lastError = derived.lastError
      entry.activityTooLarge = false
    } catch (error) {
      entry.eventsSeenMtimeMs = undefined
      warnings.push(`events.ndjson unreadable: ${describeError(error)}`)
    }
  } catch {
    // A running job may not have written events yet.
    entry.activity = []
    entry.toolCounts = []
    entry.lastText = undefined
    entry.lastError = undefined
    entry.activityTooLarge = false
    entry.eventsMtimeMs = undefined
    entry.eventsSeenMtimeMs = undefined
  }
}

/** Read `final.md` for an expanded succeeded row, once per mtime. */
async function readFinal(
  $: EngineInterface,
  dir: string,
  entry: JobCacheEntry,
  warnings: string[],
): Promise<void> {
  const finalPath = joinPath(dir, 'final.md')
  try {
    const stat = await $.fs.stat(finalPath)
    if (entry.finalSeenMtimeMs === stat.mtimeMs && entry.finalText !== undefined) {
      return
    }
    entry.finalSeenMtimeMs = stat.mtimeMs
    if (stat.size > FINAL_MAX_BYTES) {
      entry.finalTooLarge = true
      entry.finalText = undefined
      return
    }
    try {
      const source = await $.fs.read(finalPath)
      entry.finalText = firstNonEmptyLines(source, FINAL_MAX_LINES).join('\n')
      entry.finalTooLarge = false
    } catch (error) {
      entry.finalSeenMtimeMs = undefined
      warnings.push(`final.md unreadable: ${describeError(error)}`)
    }
  } catch {
    // Missing final.md is normal for a job that did not finish cleanly.
    entry.finalSeenMtimeMs = undefined
  }
}

async function refresh($: EngineInterface, options: PluginOptions): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    if (stateDir === '') {
      stateDir = await resolveStateDirFor($, options)
    }
    const jobsDir = joinPath(stateDir, 'jobs')
    let entries: FsEntry[] = []
    let missing = false
    const warnings: string[] = []
    try {
      entries = await $.fs.list(jobsDir)
    } catch {
      missing = !(await pathExists($, jobsDir))
      if (!missing) warnings.push('cannot list jobs directory')
    }

    const cwd = await projectCwd($)
    const expanded = await read($, expandedAtom)
    const expandedSet = new Set(expanded)
    const now = await $.clock.now()
    const nextCache = new Map<string, JobCacheEntry>()
    const jobs: DshJobView[] = []

    const ids = entries
      .filter(entry => entry.kind === 'dir' && isJobId(entry.name))
      .map(entry => entry.name)
      .sort()

    for (const id of ids) {
      const dir = joinPath(jobsDir, id)
      const jobPath = joinPath(dir, 'job.json')
      const entry = cache.get(id) ?? {}

      let stat
      try {
        stat = await $.fs.stat(jobPath)
      } catch (error) {
        if (entry.job !== undefined) {
          warnings.push(`${id}: job.json unreadable (showing last valid)`)
          jobs.push(toJobView(entry.job, entry))
          nextCache.set(id, entry)
        } else {
          warnings.push(`${id}: job.json unreadable: ${describeError(error)}`)
        }
        continue
      }

      if (entry.jobSeenMtimeMs !== stat.mtimeMs) {
        entry.jobSeenMtimeMs = stat.mtimeMs
        try {
          const source = await $.fs.read(jobPath)
          const parsed = parseJobJson(source, id)
          if (parsed !== null) {
            entry.job = parsed
            entry.invalid = false
          } else {
            entry.invalid = true
          }
        } catch (error) {
          entry.invalid = true
          warnings.push(`${id}: job.json unreadable: ${describeError(error)}`)
        }
      }

      if (entry.job === undefined) {
        if (entry.invalid === true) warnings.push(`${id}: invalid job.json`)
        continue
      }
      if (entry.invalid === true) {
        warnings.push(`${id}: invalid job.json (showing last valid)`)
      }

      const job = entry.job
      const isExpanded = expandedSet.has(id)
      if (isExpanded || isActiveStatus(job.status)) {
        await readEvents($, dir, entry, warnings)
      }
      if (isExpanded && job.status === 'succeeded') {
        await readFinal($, dir, entry, warnings)
      }

      jobs.push(toJobView(job, entry))
      nextCache.set(id, entry)
    }

    cache = nextCache

    const view: DshPaneView = {
      isLoaded: true,
      jobs,
      stateDir,
      jobsDir,
      projectCwd: cwd,
      updatedAtMs: now,
    }
    // A missing jobs directory is the empty state: the renderer shows
    // "No DSH jobs yet" and `stateDir`; it is not a warning.
    if (warnings.length > 0) view.warning = warnings.join(' · ')
    await writeView($, view)
  } catch (error) {
    await recordWarning($, error)
  } finally {
    inFlight = false
  }
}

function toggleExpanded(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]
}

type LinePart = {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
}

function glyphColor(glyph: string): DshStatusTone {
  return glyph === '✓' ? 'success' : glyph === '✗' ? 'error' : 'claude'
}

/** Split parts to fit a width, truncating the last one that crosses it. */
function fitParts(parts: readonly LinePart[], width: number): LinePart[] {
  let remaining = Math.max(0, Math.floor(width))
  const fitted: LinePart[] = []
  for (const part of parts) {
    if (remaining <= 0) break
    const text = truncateLine(part.text, remaining)
    if (text === '') continue
    fitted.push({ ...part, text })
    remaining -= Array.from(text).length
  }
  return fitted
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    startCwd = e.cwd

    await $.command.register({
      name: 'pane',
      description: 'Show Agent Workers in a pane',
      immediate: true,
    })

    try {
      stateDir = await resolveStateDirFor($, options)
    } catch {
      stateDir = ''
    }

    await refresh($, options)
    // session.start fires again on /clear and resume: keep a single interval.
    tick?.cancel()
    tick = $.clock.every(REFRESH_MS, () => {
      void refresh($, options).catch(() => undefined)
    })
    void $.ui
      .open({ id: PANE_ID, title: 'Agent Workers', columns: PANE_COLUMNS })
      .catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'pane' }, async $ => {
    await $.ui.open({ id: PANE_ID, title: 'Agent Workers', columns: PANE_COLUMNS })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const expanded = await read($, expandedAtom)
    const finalExpanded = await read($, finalExpandedAtom)
    const showAll = await read($, showAllAtom)
    const pendingAction = await read($, pendingActionAtom)
    const actionResults = await read($, actionResultsAtom)
    const columns = Math.max(
      1,
      Math.floor(e.props.bodyColumns ?? e.viewport?.columns ?? PANE_COLUMNS),
    )
    // The card's border (2) and paddingX (1 each side) sit inside bodyColumns.
    const innerWidth = Math.max(1, columns - 4)
    const nestedWidth = Math.max(1, innerWidth - 4)
    const expandedSet = new Set(expanded)
    const finalExpandedSet = new Set(finalExpanded)
    const rows = visibleJobs(view.jobs, {
      showAll,
      projectCwd: view.projectCwd,
    })
    const nowMs = view.updatedAtMs ?? 0
    const activePending =
      pendingAction !== null && nowMs < pendingAction.expiresAtMs
        ? pendingAction
        : undefined
    const groups: { name: string | null; jobs: DshJobView[] }[] = showAll
      ? groupJobs(rows).map(group => ({ name: group.name, jobs: group.jobs }))
      : [{ name: null, jobs: rows }]

    const line = (
      key: string,
      parts: readonly LinePart[],
      width = columns,
    ): RenderElement => {
      const fitted = fitParts(parts, width)
      const only = fitted[0]
      if (fitted.length === 1 && only !== undefined) {
        return (
          <Text
            key={key}
            color={only.color}
            bold={only.bold}
            dimColor={only.dim}
            italic={only.italic}
          >
            {only.text}
          </Text>
        )
      }
      return (
        <Text key={key}>
          {fitted.map((part, index) => (
            <Text
              key={`${key}:${index}`}
              color={part.color}
              bold={part.bold}
              dimColor={part.dim}
              italic={part.italic}
            >
              {part.text}
            </Text>
          ))}
        </Text>
      )
    }

    const joinParts = (
      parts: readonly LinePart[],
      separator = ' · ',
    ): LinePart[] => {
      const joined: LinePart[] = []
      parts.forEach((part, index) => {
        if (index > 0) joined.push({ text: separator, dim: true })
        joined.push(part)
      })
      return joined
    }

    const summary = summarySegments(rows)
    const summaryParts: LinePart[] = []
    if (summary.length === 0) {
      summaryParts.push({ text: 'idle', dim: true })
    } else {
      summary.forEach((segment, index) => {
        if (index > 0) summaryParts.push({ text: ' · ', dim: true })
        summaryParts.push({ text: segment.text, color: segment.tone })
      })
    }

    const totals: LinePart[] = []
    const cost = totalCost(rows)
    const tokens = totalTokens(rows)
    if (cost !== undefined) {
      const formatted = formatCost(cost)
      if (formatted !== undefined) totals.push({ text: formatted, dim: true })
    }
    if (tokens !== undefined) {
      totals.push({ text: `${formatTokens(tokens)} tok`, dim: true })
    }
    const identity = newestJob(rows)
    if (identity !== undefined) {
      const found = jobIdentity(identity)
      if (found !== undefined) totals.push({ text: found, dim: true })
    }

    const renderJob = (job: DshJobView): RenderElement => {
      const isExpanded = expandedSet.has(job.id)
      const status = statusDisplay(job.status)
      const jobPending =
        activePending !== undefined && activePending.jobId === job.id
          ? activePending
          : undefined
      const actionResult = actionResults[job.id]
      const canCleanup =
        status.isTerminal &&
        job.worktree !== undefined &&
        job.worktree.cleaned !== true
      const dimBorder =
        status.isTerminal &&
        job.status !== 'failed' &&
        job.status !== 'timed_out'
      const arrow = isExpanded ? '▼' : '▶'
      const badge = truncateLine(status.label, Math.max(1, innerWidth - 4))
      const badgeText = ` ${badge} `
      const labelMax = Math.max(
        1,
        innerWidth - badgeText.length - arrow.length - 1,
      )
      const label = truncateLine(
        sanitizeLine(job.label === '' ? job.id : job.label),
        labelMax,
      )
      const meta = jobMetaLine(job, nowMs)
      const details: RenderElement[] = []

      if (meta !== '') {
        details.push(line(`meta:${job.id}`, [{ text: meta, dim: true }], innerWidth))
      }

      if (job.alerts.length > 0) {
        details.push(
          line(
            `alerts:${job.id}`,
            [{ text: alertsLine(job.alerts), color: 'warning' }],
            innerWidth,
          ),
        )
      }

      if (isRunningStatus(job.status)) {
        const latest = job.activity[job.activity.length - 1]
        const tool = latest?.tool ?? job.lastTool
        const glyph = latest?.glyph ?? '◌'
        const runParts: LinePart[] = []
        if (tool !== undefined) {
          runParts.push({ text: glyph, color: glyphColor(glyph) })
          runParts.push({ text: ' ' })
          runParts.push({ text: tool, bold: true })
          if (latest !== undefined && latest.summary !== '') {
            runParts.push({ text: ` · ${latest.summary}`, dim: true })
          }
        } else if (job.activityTooLarge === true) {
          runParts.push({ text: 'activity log too large', dim: true })
        } else {
          runParts.push({ text: 'no activity yet', dim: true })
        }
        const age = eventsAgeMs(job, nowMs)
        if (age !== undefined) {
          if (isStalledRunning(job, nowMs)) {
            runParts.push({ text: ' · ', dim: true })
            runParts.push({
              text: `⚠ no events for ${formatAgo(age).replace(/ ago$/, '')}`,
              color: 'warning',
            })
          } else {
            runParts.push({ text: ` · ${formatAgo(age)}`, dim: true })
          }
        }
        details.push(line(`run:${job.id}`, runParts, innerWidth))
      }

      if (isExpanded) {
        details.push(
          line(
            `activity-title:${job.id}`,
            [{ text: '─ activity', dim: true }],
            innerWidth,
          ),
        )
        if (job.activityTooLarge === true) {
          details.push(
            line(
              `activity-large:${job.id}`,
              [{ text: 'activity log too large', dim: true }],
              innerWidth,
            ),
          )
        } else if (job.activity.length === 0) {
          details.push(
            line(
              `activity-empty:${job.id}`,
              [{ text: 'no activity yet', dim: true }],
              innerWidth,
            ),
          )
        } else {
          for (const activity of job.activity) {
            const parts: LinePart[] = [
              { text: activity.glyph, color: glyphColor(activity.glyph) },
              { text: ' ' },
              { text: activity.tool, bold: true },
            ]
            if (activity.summary !== '') {
              parts.push({ text: ` · ${activity.summary}`, dim: true })
            }
            details.push(
              line(
                `activity:${job.id}:${activity.callId}`,
                parts,
                innerWidth,
              ),
            )
          }
        }
        if (job.lastError !== undefined) {
          details.push(
            line(
              `last-error:${job.id}`,
              [
                {
                  text: `⚠ ${sanitizeLine(job.lastError)}`,
                  color: 'warning',
                },
              ],
              innerWidth,
            ),
          )
        }

        if (job.toolCounts.length > 0) {
          details.push(
            line(
              `tools-title:${job.id}`,
              [{ text: '─ tools', dim: true }],
              innerWidth,
            ),
            line(
              `tools:${job.id}`,
              [{ text: toolCountsLine(job.toolCounts) }],
              innerWidth,
            ),
          )
        }

        if (isRunningStatus(job.status) && job.lastText !== undefined) {
          details.push(
            line(
              `says-title:${job.id}`,
              [{ text: '─ says', dim: true }],
              innerWidth,
            ),
          )
          const says = firstNonEmptyLines(job.lastText, SAYS_LINES)
          for (let index = 0; index < says.length; index += 1) {
            details.push(
              line(
                `says:${job.id}:${index}`,
                [{ text: sanitizeLine(says[index] ?? ''), italic: true }],
                innerWidth,
              ),
            )
          }
        }

        details.push(
          line(
            `details-title:${job.id}`,
            [{ text: '─ details', dim: true }],
            innerWidth,
          ),
        )
        let detailLines = 0
        const profile = [job.profile, job.provider]
          .filter((value): value is string => value !== undefined)
          .join(' / ')
        if (profile !== '') {
          details.push(
            line(
              `profile:${job.id}`,
              [
                { text: 'profile/provider ', dim: true },
                { text: sanitizeLine(profile) },
              ],
              innerWidth,
            ),
          )
          detailLines += 1
        }
        if (job.access !== undefined) {
          const access = accessDisplay(job.access)
          const accessParts: LinePart[] = [
            { text: 'access ', dim: true },
            { text: sanitizeLine(access.label), color: access.tone },
          ]
          const isolation = isolationDisplay(job)
          if (isolation !== undefined) {
            accessParts.push({ text: ' · ', dim: true })
            accessParts.push({ text: sanitizeLine(isolation) })
          }
          details.push(line(`access:${job.id}`, accessParts, innerWidth))
          detailLines += 1
        }
        const branch = branchLine(job.worktree)
        if (branch !== undefined) {
          details.push(
            line(
              `branch:${job.id}`,
              [
                { text: 'branch ', dim: true },
                { text: sanitizeLine(branch) },
              ],
              innerWidth,
            ),
          )
          detailLines += 1
        }
        if (job.groupName !== undefined) {
          details.push(
            line(
              `group:${job.id}`,
              [
                { text: 'group ', dim: true },
                { text: sanitizeLine(job.groupName) },
              ],
              innerWidth,
            ),
          )
          detailLines += 1
        }
        const started = formatTimestamp(job.startedAt)
        const elapsed = elapsedMs(job, nowMs)
        if (started !== undefined || elapsed !== undefined) {
          const startedParts: LinePart[] = [{ text: 'started ', dim: true }]
          if (started !== undefined) startedParts.push({ text: started })
          if (started !== undefined && elapsed !== undefined) {
            startedParts.push({ text: ' · ', dim: true })
          }
          if (elapsed !== undefined) {
            startedParts.push({ text: formatDuration(elapsed), dim: true })
          }
          details.push(
            line(`started:${job.id}`, startedParts, innerWidth),
          )
          detailLines += 1
        }
        if (job.turnEndKind !== undefined) {
          details.push(
            line(
              `turn-end:${job.id}`,
              [
                { text: 'turn end ', dim: true },
                { text: sanitizeLine(job.turnEndKind) },
              ],
              innerWidth,
            ),
          )
          detailLines += 1
        }
        if ((job.malformedLines ?? 0) > 0) {
          details.push(
            line(
              `malformed:${job.id}`,
              [
                {
                  text: `⚠ ${job.malformedLines ?? 0} malformed lines`,
                  color: 'warning',
                },
              ],
              innerWidth,
            ),
          )
          detailLines += 1
        }
        if (detailLines === 0) {
          details.push(
            line(
              `details-empty:${job.id}`,
              [{ text: 'no details', dim: true }],
              innerWidth,
            ),
          )
        }

        const usage = job.usage
        if (usage !== undefined || job.costUsd !== undefined) {
          details.push(
            line(
              `tokens-title:${job.id}`,
              [{ text: '─ tokens', dim: true }],
              innerWidth,
            ),
          )
          const tokenParts: LinePart[] = []
          if (usage?.inputTokens !== undefined) {
            tokenParts.push({ text: 'in ', dim: true })
            tokenParts.push({ text: formatTokens(usage.inputTokens) })
          }
          if (usage?.outputTokens !== undefined) {
            if (tokenParts.length > 0) tokenParts.push({ text: ' · ', dim: true })
            tokenParts.push({ text: 'out ', dim: true })
            tokenParts.push({ text: formatTokens(usage.outputTokens) })
          }
          if (usage?.cacheReadTokens !== undefined) {
            if (tokenParts.length > 0) tokenParts.push({ text: ' · ', dim: true })
            tokenParts.push({ text: 'cache ', dim: true })
            tokenParts.push({ text: formatTokens(usage.cacheReadTokens) })
            const hit = cacheHitPercent(usage)
            if (hit !== undefined) {
              tokenParts.push({ text: ` (${hit}% hit)`, dim: true })
            }
          }
          if (tokenParts.length === 0 && usage !== undefined) {
            const total = usageTokens(usage)
            if (total !== undefined) {
              tokenParts.push({ text: 'total ', dim: true })
              tokenParts.push({ text: formatTokens(total) })
            }
          }
          if (tokenParts.length > 0) {
            details.push(line(`tokens:${job.id}`, tokenParts, innerWidth))
          }
          if (usage?.cacheWriteTokens !== undefined) {
            details.push(
              line(
                `cache-write:${job.id}`,
                [
                  { text: 'cache write ', dim: true },
                  { text: formatTokens(usage.cacheWriteTokens) },
                ],
                innerWidth,
              ),
            )
          }
          if (usage?.reasoningTokens !== undefined) {
            details.push(
              line(
                `reasoning:${job.id}`,
                [
                  { text: 'reasoning ', dim: true },
                  { text: formatTokens(usage.reasoningTokens) },
                ],
                innerWidth,
              ),
            )
          }
          const jobCost = formatCost(job.costUsd)
          if (jobCost !== undefined) {
            details.push(
              line(
                `cost:${job.id}`,
                [
                  { text: 'cost ', dim: true },
                  { text: jobCost, bold: true },
                ],
                innerWidth,
              ),
            )
          }
        }

        if (job.status === 'succeeded') {
          details.push(
            line(
              `result-title:${job.id}`,
              [{ text: '─ result', dim: true }],
              innerWidth,
            ),
          )
          if (job.finalTooLarge === true) {
            details.push(
              line(
                `final-large:${job.id}`,
                [{ text: 'final.md too large', dim: true }],
                innerWidth,
              ),
            )
          } else if (job.finalText !== undefined && job.finalText !== '') {
            const full = truncateLines(job.finalText, innerWidth)
            const preview = truncateLines(
              firstNonEmptyLines(job.finalText, FINAL_LINES).join('\n'),
              innerWidth,
            )
            const showFull = finalExpandedSet.has(job.id)
            details.push(
              <Markdown
                key={`final-md:${job.id}`}
                text={showFull ? full : preview}
              />,
            )
            if (full !== preview) {
              details.push(
                <Button
                  key={`final:${job.id}`}
                  plain
                  dimColor
                  onPress={() => {
                    void update($, finalExpandedAtom, ids =>
                      toggleExpanded(ids, job.id),
                    )
                  }}
                >
                  {showFull ? 'less' : 'more'}
                </Button>,
              )
            }
          } else {
            details.push(
              line(
                `final-empty:${job.id}`,
                [{ text: 'no final.md', dim: true }],
                innerWidth,
              ),
            )
          }
        }

        if (
          job.status === 'failed' ||
          job.status === 'timed_out' ||
          job.status === 'interrupted'
        ) {
          details.push(
            line(
              `result-title:${job.id}`,
              [{ text: '─ result', dim: true }],
              innerWidth,
            ),
          )
          const errorLines: RenderElement[] = []
          if (job.reason !== undefined) {
            errorLines.push(
              line(
                `reason:${job.id}`,
                [{ text: `reason: ${sanitizeLine(job.reason)}`, color: 'error' }],
                nestedWidth,
              ),
            )
          }
          const messages = firstNonEmptyLines(
            job.errorMessage ?? '',
            ERROR_LINES,
          )
          messages.forEach((message, index) => {
            errorLines.push(
              line(
                `error-message:${job.id}:${index}`,
                [{ text: sanitizeLine(message), color: 'error' }],
                nestedWidth,
              ),
            )
          })
          const stderr = lastNonEmptyLines(job.stderrTail, STDERR_LINES)
          stderr.forEach((value, index) => {
            const prefix = index === 0 ? 'stderr: ' : ' '
            errorLines.push(
              line(
                `stderr:${job.id}:${index}`,
                [{ text: sanitizeLine(`${prefix}${value}`), dim: true }],
                nestedWidth,
              ),
            )
          })
          if (errorLines.length === 0) {
            errorLines.push(
              line(
                `error-empty:${job.id}`,
                [{ text: 'no error details', dim: true }],
                nestedWidth,
              ),
            )
          }
          details.push(
            <Box
              key={`error:${job.id}`}
              flexDirection="column"
              borderStyle="single"
              borderColor="error"
              paddingX={1}
            >
              {errorLines}
            </Box>,
          )
        }

        details.push(
          <Box key={`actions:${job.id}`} flexDirection="row" gap={1}>
            <Button
              key={`copy-id:${job.id}`}
              plain
              dimColor
              onPress={press => {
                void $.ui
                  .copy({ text: job.id, surface: press.surface })
                  .catch(() => undefined)
              }}
            >
              copy id
            </Button>
            {job.worktree?.branch !== undefined && (
              <Button
                key={`copy-branch:${job.id}`}
                plain
                dimColor
                onPress={press => {
                  void $.ui
                    .copy({
                      text: job.worktree?.branch ?? '',
                      surface: press.surface,
                    })
                    .catch(() => undefined)
                }}
              >
                copy branch
              </Button>
            )}
            {canCleanup && (
              <Button
                key={`cleanup:${job.id}`}
                plain
                dimColor={
                  !(
                    jobPending?.action === 'cleanup' &&
                    jobPending.stage === 'confirm'
                  )
                }
                onPress={() => {
                  void pressAction($, job, 'cleanup', 'confirm')
                }}
              >
                {jobPending?.action === 'cleanup' &&
                jobPending.stage === 'confirm' ? (
                  <Text color="warning">confirm cleanup?</Text>
                ) : (
                  'cleanup'
                )}
              </Button>
            )}
            {status.isTerminal && (
              <Button
                key={`delete:${job.id}`}
                plain
                dimColor={
                  !(
                    jobPending?.action === 'delete' &&
                    jobPending.stage === 'confirm'
                  )
                }
                onPress={() => {
                  void pressAction($, job, 'delete', 'confirm')
                }}
              >
                {jobPending?.action === 'delete' &&
                jobPending.stage === 'confirm' ? (
                  <Text color="warning">confirm delete?</Text>
                ) : (
                  'delete'
                )}
              </Button>
            )}
            {status.isTerminal &&
              actionResult?.needsDiscard === true &&
              actionResult.action === 'cleanup' && (
                <Button
                  key={`discard-clean:${job.id}`}
                  plain
                  dimColor={
                    !(
                      jobPending?.action === 'cleanup' &&
                      jobPending.stage === 'discard'
                    )
                  }
                  onPress={() => {
                    void pressAction($, job, 'cleanup', 'discard')
                  }}
                >
                  {jobPending?.action === 'cleanup' &&
                  jobPending.stage === 'discard' ? (
                    <Text color="warning">confirm discard?</Text>
                  ) : (
                    'discard & clean'
                  )}
                </Button>
              )}
            {status.isTerminal &&
              actionResult?.needsDiscard === true &&
              actionResult.action === 'delete' && (
                <Button
                  key={`discard-delete:${job.id}`}
                  plain
                  dimColor={
                    !(
                      jobPending?.action === 'delete' &&
                      jobPending.stage === 'discard'
                    )
                  }
                  onPress={() => {
                    void pressAction($, job, 'delete', 'discard')
                  }}
                >
                  {jobPending?.action === 'delete' &&
                  jobPending.stage === 'discard' ? (
                    <Text color="warning">confirm discard?</Text>
                  ) : (
                    'discard & delete'
                  )}
                </Button>
              )}
          </Box>,
        )
        if (actionResult !== undefined && status.isTerminal) {
          details.push(
            line(
              `action-result:${job.id}`,
              [{ text: actionResult.text, color: actionResult.tone }],
              innerWidth,
            ),
          )
        }
      }

      const alertActive = status.isActive && job.alerts.length > 0
      return (
        <Box
          key={job.id}
          flexDirection="column"
          borderStyle="round"
          borderColor={alertActive ? 'warning' : status.tone}
          borderDimColor={dimBorder}
          paddingX={1}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Button
              key={`job:${job.id}`}
              plain
              onPress={() => {
                void update($, expandedAtom, ids => toggleExpanded(ids, job.id))
              }}
            >
              {`${arrow} ${label}`}
            </Button>
            <Text bold color={status.tone}>
              {badgeText}
            </Text>
          </Box>
          {details}
        </Box>
      )
    }

    const scope = showAll ? 'all' : 'this project'
    const title = truncateLine('Agent Workers', Math.max(1, columns))
    const scopeWidth = Math.max(1, columns - title.length - 1)
    const footer = (
      <Box key="footer" flexDirection="column" marginTop={1}>
        <Text dimColor>
          {truncateLine(
            view.updatedAtMs === null
              ? 'Updated —'
              : `Updated ${formatClockTime(view.updatedAtMs)}`,
            columns,
          )}
        </Text>
        {view.warning !== undefined && (
          <Text color="warning">
            {truncateLine(`⚠ ${view.warning}`, columns)}
          </Text>
        )}
      </Box>
    )

    // Optional: an explicit fill so the pane can match the terminal background.
    const background = paneBackground(options.pane_background)
    return (
      <Box
        flexDirection="column"
        backgroundColor={background}
        minHeight={background === undefined ? undefined : e.props.scroll?.bodyRows}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="claude">
            {truncateLine(title, Math.max(1, columns - scope.length - 1))}
          </Text>
          <Button
            key="toggle-filter"
            plain
            dimColor
            onPress={() => {
              void update($, showAllAtom, value => !value)
            }}
          >
            {truncateLine(scope, scopeWidth)}
          </Button>
        </Box>
        {line('summary', summaryParts, columns)}
        {totals.length > 0 && line('totals', joinParts(totals), columns)}

        {!view.isLoaded && (
          <Text dimColor>{truncateLine('Loading worker jobs…', columns)}</Text>
        )}
        {view.isLoaded && view.jobs.length === 0 && (
          <Text dimColor>{truncateLine('No worker jobs yet', columns)}</Text>
        )}
        {view.isLoaded && view.jobs.length === 0 && view.stateDir !== '' && (
          <Text dimColor>{truncateLine(view.stateDir, columns)}</Text>
        )}
        {view.isLoaded && rows.length === 0 && view.jobs.length > 0 && (
          <Text dimColor>
            {truncateLine('No jobs for this project', columns)}
          </Text>
        )}

        {rows.length > 0 && (
          <Box flexDirection="column" gap={1} marginTop={1}>
            {groups.map(group => (
              <Box
                key={`group:${group.name ?? 'project'}`}
                flexDirection="column"
                gap={1}
              >
                {group.name !== null && (
                  <Text dimColor bold>
                    {truncateLine(sanitizeLine(group.name), columns)}
                  </Text>
                )}
                {group.jobs.map(job => renderJob(job))}
              </Box>
            ))}
          </Box>
        )}

        {footer}
      </Box>
    )
  })
}
