/**
 * The data contract for `agent-workers`'s `$.state` values.
 *
 * The atoms live in `PluginState['agent-workers']` keyed by the plugin's
 * manifest name. All values are plain JSON data so they survive a hot reload.
 */

/** The colour name a status maps to; all are theme keys the surfaces accept. */
export type DshStatusTone =
  | 'success'
  | 'error'
  | 'warning'
  | 'inactive'
  | 'suggestion'
  | 'subtle'
  | 'claude'
  | 'text'

/** One row's status presentation, derived from `job.json`'s `status`. */
export type DshStatusDisplay = {
  label: string
  tone: DshStatusTone
  isActive: boolean
  isTerminal: boolean
}

/** One `tool_call` event, paired with its `tool_result` when there is one. */
export type DshActivity = {
  callId: string
  tool: string
  summary: string
  glyph: '✓' | '✗' | '◌'
}

/** One tool's call count, for the expanded `tools` section. */
export type DshToolCount = {
  tool: string
  count: number
}

/** The watchdog alert kinds the MCP persists in `job.json`. */
export type DshAlertKind = 'stalled' | 'loop' | 'tool_errors' | 'budget'

/** One current watchdog alert from `job.json`. */
export type DshAlert = {
  kind: DshAlertKind
  message: string
  since?: string
}

/** The `worktree` object of a worktree job, defensively normalized. */
export type DshWorktree = {
  path?: string
  branch?: string
  baseCommit?: string
  repoRoot?: string
  cleaned?: boolean
}

/** The `usage` object of `job.json`, defensively normalized. */
export type DshUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * A normalized `job.json`. Every field is optional in the file, so only `id`,
 * `label`, `status` and `stderrTail` are guaranteed after normalization.
 */
export type DshJob = {
  id: string
  label: string
  status: string
  groupId?: string
  groupName?: string
  ownerId?: string
  cwd?: string
  access?: string
  isolation?: string
  reason?: string
  errorMessage?: string
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  worktree?: DshWorktree
  stderrTail: string
  malformedLines?: number
  eventsCount?: number
  toolCalls?: number
  steps?: number
  lastTool?: string
  turnEndKind?: string
  usage?: DshUsage
  costUsd?: number
  profile?: string
  provider?: string
  model?: string
  alerts: DshAlert[]
}

/**
 * A job as the pane stores it: the normalized job plus what was read beside
 * it. Events are read for active jobs and for any expanded row; `finalText`
 * is read for expanded succeeded rows.
 */
export type DshJobView = DshJob & {
  activity: DshActivity[]
  activityTooLarge?: boolean
  toolCounts: DshToolCount[]
  lastText?: string
  lastError?: string
  /** Age anchor for the running row: `events.ndjson`'s mtime. */
  eventsMtimeMs?: number
  /** `final.md` kept to `FINAL_MAX_LINES` non-empty lines. */
  finalText?: string
  finalTooLarge?: boolean
}

/** Everything a refresh derives, in memory only (the render hook reads it). */
export type DshPaneView = {
  isLoaded: boolean
  jobs: DshJobView[]
  stateDir: string
  jobsDir: string
  projectCwd: string
  /** The `$.clock.now()` of the last successful refresh. */
  updatedAtMs: number | null
  warning?: string
}

/** The terminal-row actions the pane can call on the MCP server. */
export type DshActionKind = 'delete' | 'cleanup'

/**
 * The one press that still needs a confirming second press. `stage` is the
 * first confirm (`confirm delete?`) or the discard confirm after the server
 * reported a dirty worktree. Expiry is absolute `$.clock.now()` milliseconds.
 */
export type DshPendingAction = {
  jobId: string
  action: DshActionKind
  stage: 'confirm' | 'discard'
  expiresAtMs: number
}

/** What a completed (or refused) action reports on the job card. */
export type DshActionResult = {
  action: DshActionKind
  kind: 'deleted' | 'cleaned' | 'dirty' | 'error'
  text: string
  tone: DshStatusTone
  /** True when the worktree must be discarded before the action can finish. */
  needsDiscard?: boolean
  atMs: number
}

/** The latest action result by job id; stale entries for gone jobs are inert. */
export type DshActionResults = Record<string, DshActionResult>

declare module 'claude-code' {
  interface PluginState {
    'agent-workers': {
      view: DshPaneView
      expanded: string[]
      finalExpanded: string[]
      showAll: boolean
      pendingAction: DshPendingAction | null
      actionResults: DshActionResults
    }
  }
}
