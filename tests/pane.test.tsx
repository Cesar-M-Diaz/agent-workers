import { describe, expect, mock, test } from 'claude-code/testing'
import type { McpConnectResult, McpToolResult, On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import type { DshJob } from '../types'
import {
  activityFromEvents,
  alertsLine,
  belongsToProject,
  branchLine,
  cacheHitPercent,
  deriveActivity,
  deriveJobEvents,
  eventsAgeMs,
  formatAgo,
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  groupJobs,
  isSameOrInside,
  isStalledRunning,
  jobEventsFromSource,
  jobIdentity,
  jobMetaLine,
  normalizeJob,
  parseEventLines,
  parseJobJson,
  paneBackground,
  resolveStateDir,
  sortJobs,
  statusDisplay,
  summarySegments,
  toolCountsLine,
  truncateLine,
  visibleJobs,
} from '../hooks/jobs'

// ---------------------------------------------------------------------------
// Unit tests: the pure logic in hooks/jobs.ts
// ---------------------------------------------------------------------------

describe('jobs.ts', () => {
  test('normalizes missing and garbage job.json fields defensively', () => {
    const parsed = normalizeJob(
      {
        id: 7,
        label: null,
        status: 9,
        steps: 'many',
        toolCalls: -1,
        costUsd: 'free',
        worktree: 'no',
        createdAt: 5,
        stderrTail: undefined,
      },
      'j_dir',
    )
    expect(parsed).not.toBeNull()
    const job = parsed as DshJob
    expect(job.id).toBe('j_dir')
    expect(job.label).toBe('j_dir')
    expect(job.status).toBe('unknown')
    expect(job.steps).toBeUndefined()
    expect(job.toolCalls).toBeUndefined()
    expect(job.costUsd).toBeUndefined()
    expect(job.worktree).toBeUndefined()
    expect(job.createdAt).toBeUndefined()
    expect(job.stderrTail).toBe('')

    expect(parseJobJson('{"id":', 'j_dir')).toBeNull()
    expect(normalizeJob('not an object', 'j_dir')).toBeNull()
  })

  test('normalizes a real-shaped job.json and its nested objects', () => {
    const parsed = normalizeJob(
      {
        id: 'j_1c3a1b73b269',
        label: 'chat-auto-model',
        status: 'succeeded',
        steps: 44,
        toolCalls: 66,
        costUsd: 0.0412,
        createdAt: '2026-10-20T15:07:36.668Z',
        worktree: {
          path: '/state/worktrees/j_1',
          branch: 'dsh/j_1',
          repoRoot: '/repo',
          cleaned: false,
        },
        usage: { inputTokens: 81664, outputTokens: 21803, totalTokens: 2670379 },
      },
      'j_1c3a1b73b269',
    )
    expect(parsed?.worktree?.repoRoot).toBe('/repo')
    expect(parsed?.usage?.totalTokens).toBe(2670379)
    expect(parsed?.steps).toBe(44)
    expect(parsed?.toolCalls).toBe(66)
    expect(parsed?.costUsd).toBe(0.0412)
  })

  test('normalizes watchdog alerts defensively', () => {
    const parsed = normalizeJob(
      {
        id: 'j_alert',
        status: 'running',
        alerts: [
          {
            kind: 'loop',
            message: 'same bash call repeated 5× in last 10',
            since: '2026-10-20T15:07:36.000Z',
          },
          { kind: 'not-a-kind', message: 'ignored' },
          { kind: 'budget', message: '   ' },
          'garbage',
        ],
      },
      'j_alert',
    )
    expect(parsed?.alerts).toEqual([
      {
        kind: 'loop',
        message: 'same bash call repeated 5× in last 10',
        since: '2026-10-20T15:07:36.000Z',
      },
    ])
    expect(normalizeJob({ id: 'j_plain' }, 'j_plain')?.alerts).toEqual([])
    expect(normalizeJob({ id: 'j_bad', alerts: 'no' }, 'j_bad')?.alerts).toEqual([])
    expect(
      alertsLine([
        { kind: 'loop', message: 'same bash call repeated 5× in last 10' },
        { kind: 'budget', message: '12 steps exceeds limit 10' },
      ]),
    ).toBe(
      '⚠ loop · same bash call repeated 5× in last 10 · ⚠ budget · 12 steps exceeds limit 10',
    )
  })

  test('maps every status, including unknown raw values, safely', () => {
    expect(statusDisplay('queued').label).toBe('○ QUEUED')
    expect(statusDisplay('starting').label).toBe('◌ RUNNING')
    expect(statusDisplay('running').label).toBe('◌ RUNNING')
    expect(statusDisplay('succeeded').label).toBe('✓ SUCCEEDED')
    expect(statusDisplay('failed').label).toBe('✗ FAILED')
    expect(statusDisplay('timed_out').label).toBe('✗ TIMED_OUT')
    expect(statusDisplay('cancelled').label).toBe('− CANCELLED')
    expect(statusDisplay('interrupted').label).toBe('⚠ INTERRUPTED')
    expect(statusDisplay('running').isActive).toBe(true)
    expect(statusDisplay('succeeded').isTerminal).toBe(true)
    expect(statusDisplay('weird\nstatus').label).toBe('? weird status')
    expect(statusDisplay('').label).toBe('? unknown')
  })

  test('parses event lines and ignores a partial last line', () => {
    const source = [
      '{"type":"session","sessionId":"session-1"}',
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"tool_call","callId":"c1","tool":"bash"}',
      '{"type":"tool_call","callId":"c2",',
    ].join('\n')
    const events = parseEventLines(source)
    expect(events).toHaveLength(3)
    expect(events[0]?.type).toBe('session')
    expect(events[2]?.callId).toBe('c1')

    expect(parseEventLines('not json\n\n{"type":"status"}\n')).toHaveLength(1)
  })

  test('derives activity with ✓, ✗ and ◌ from tool calls and results', () => {
    const activity = activityFromEvents(
      [
        '{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"pnpm test","description":"Run tests"}}',
        '{"type":"tool_result","callId":"c1","status":"completed","result":"ok"}',
        '{"type":"tool_call","callId":"c2","tool":"edit","input":{"file_path":"src/a.ts"}}',
        '{"type":"tool_result","callId":"c2","status":"error"}',
        '{"type":"tool_call","callId":"c3","tool":"read","input":{"pattern":"TODO"}}',
      ].join('\n'),
    )
    expect(activity.map(item => item.glyph)).toEqual(['✓', '✗', '◌'])
    expect(activity[0]?.tool).toBe('bash')
    expect(activity[0]?.summary).toBe('pnpm test')
    expect(activity[1]?.summary).toBe('src/a.ts')
    expect(activity[2]?.summary).toBe('TODO')
  })

  test('the activity list is the last 8 tool calls', () => {
    const lines: string[] = []
    for (let index = 0; index < 10; index += 1) {
      lines.push(
        JSON.stringify({
          type: 'tool_call',
          callId: `c${index}`,
          tool: 'bash',
          input: { command: `echo ${index}` },
        }),
      )
    }
    const activity = deriveActivity(parseEventLines(lines.join('\n')))
    expect(activity).toHaveLength(8)
    expect(activity[0]?.callId).toBe('c2')
    expect(activity[7]?.callId).toBe('c9')
  })

  test('filters by worktree.repoRoot or cwd against the session cwd', () => {
    expect(
      belongsToProject(
        { cwd: '/state/worktrees/j_1', worktree: { repoRoot: '/repo' } },
        '/repo',
      ),
    ).toBe(true)
    expect(belongsToProject({ cwd: '/repo/sub' }, '/repo')).toBe(true)
    expect(belongsToProject({ cwd: '/repo' }, '/repo')).toBe(true)
    expect(belongsToProject({ cwd: '/repo-other' }, '/repo')).toBe(false)
    expect(
      belongsToProject(
        { cwd: '/repo', worktree: { repoRoot: '/elsewhere' } },
        '/repo',
      ),
    ).toBe(false)
    expect(isSameOrInside('/repo/', '/repo')).toBe(true)
    expect(isSameOrInside('/repository', '/repo')).toBe(false)
  })

  test('sorts active first, newest createdAt, and caps terminal rows at 30', () => {
    const jobs: Array<
      Pick<DshJob, 'id' | 'status' | 'createdAt' | 'cwd' | 'worktree'>
    > = []
    for (let index = 0; index < 35; index += 1) {
      jobs.push({
        id: `t${index}`,
        status: 'succeeded',
        createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
        cwd: '/repo',
      })
    }
    jobs.push({
      id: 'a1',
      status: 'running',
      createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      cwd: '/repo',
    })
    jobs.push({
      id: 'a2',
      status: 'queued',
      createdAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      cwd: '/repo',
    })

    const sorted = sortJobs(jobs)
    expect(sorted[0]?.id).toBe('a2')
    expect(sorted[1]?.id).toBe('a1')

    const visible = visibleJobs(jobs, { showAll: true, projectCwd: '/repo' })
    expect(visible).toHaveLength(32)
    expect(visible[0]?.status).toBe('queued')
    expect(visible[1]?.status).toBe('running')
    expect(visible[2]?.id).toBe('t34')
    expect(visible.some(job => job.id === 't0')).toBe(false)
  })

  test('groups all-mode rows by groupName and formats the small helpers', () => {
    const groups = groupJobs([
      { groupName: 'alpha' },
      { groupName: 'beta' },
      { groupName: 'alpha' },
      {},
    ])
    expect(groups.map(group => group.name)).toEqual([
      'alpha',
      'beta',
      'Other',
    ])
    expect(groups[0]?.jobs).toHaveLength(2)
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(62_000)).toBe('1m02s')
    expect(formatCost(0.0412)).toBe('$0.04')
    expect(formatCost(undefined)).toBeUndefined()
    expect(truncateLine('abcdef', 4)).toBe('abc…')
    expect(truncateLine('abc', 10)).toBe('abc')
  })

  test('formats tokens, durations, costs, cache hits and ages', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(81_600)).toBe('81.6k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(192_000)).toBe('3m12s')
    expect(formatDuration(3_840_000)).toBe('1h04m')
    expect(formatCost(0.09)).toBe('$0.09')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0)).toBe('$0.00')
    expect(
      cacheHitPercent({ inputTokens: 81_600, cacheReadTokens: 2_500_000 }),
    ).toBe(97)
    expect(cacheHitPercent({})).toBeUndefined()
    expect(cacheHitPercent({ cacheReadTokens: 10 })).toBeUndefined()
    expect(formatAgo(0)).toBe('just now')
    expect(formatAgo(3_000)).toBe('3s ago')
    expect(formatAgo(90_000)).toBe('2m ago')
    expect(formatAgo(3_600_000)).toBe('1h ago')
    expect(formatTimestamp('not a date')).toBeUndefined()
  })

  test('summarizes visible rows with coloured status segments', () => {
    const segments = summarySegments([
      { status: 'running' },
      { status: 'starting' },
      { status: 'queued' },
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'failed' },
      { status: 'timed_out' },
      { status: 'interrupted' },
      { status: 'cancelled' },
      { status: 'mystery' },
    ])
    expect(segments.map(segment => segment.text)).toEqual([
      '◌ 2 running',
      '○ 1 queued',
      '✓ 5',
      '✗ 2',
      '⚠ 1 interrupted',
      '− 1 cancelled',
      '? 1 other',
    ])
    expect(segments.map(segment => segment.tone)).toEqual([
      'claude',
      'inactive',
      'success',
      'error',
      'warning',
      'inactive',
      'subtle',
    ])
    expect(summarySegments([])).toEqual([])
  })

  test('derives tool counts, last text and last error in one pass', () => {
    const lines: string[] = []
    for (let index = 0; index < 3; index += 1) {
      lines.push(
        JSON.stringify({
          type: 'tool_call',
          callId: `b${index}`,
          tool: 'bash',
          input: { command: `echo ${index}` },
        }),
      )
    }
    for (let index = 0; index < 2; index += 1) {
      lines.push(
        JSON.stringify({
          type: 'tool_call',
          callId: `r${index}`,
          tool: 'read',
          input: { file_path: `src/${index}.ts` },
        }),
      )
    }
    lines.push(
      JSON.stringify({
        type: 'tool_call',
        callId: 'g1',
        tool: 'grep',
        input: { pattern: 'TODO' },
      }),
      JSON.stringify({
        type: 'tool_call',
        callId: 'e1',
        tool: 'edit',
        input: { file_path: 'src/a.ts' },
      }),
      JSON.stringify({
        type: 'tool_call',
        callId: 'x1',
        tool: 'write',
        input: { file_path: 'src/b.ts' },
      }),
      JSON.stringify({
        type: 'tool_call',
        callId: 'z1',
        tool: 'glob',
        input: { pattern: '*.ts' },
      }),
      JSON.stringify({ type: 'tool_result', callId: 'b0', status: 'completed' }),
      JSON.stringify({ type: 'tool_result', callId: 'b1', status: 'completed' }),
      JSON.stringify({ type: 'error', message: '  boom happened  ' }),
      JSON.stringify({ type: 'text', text: '  first pass  ' }),
      JSON.stringify({ type: 'text', text: '  final answer  ' }),
    )
    const derived = deriveJobEvents(parseEventLines(lines.join('\n')))
    expect(derived.toolCounts).toEqual([
      { tool: 'bash', count: 3 },
      { tool: 'read', count: 2 },
      { tool: 'edit', count: 1 },
      { tool: 'glob', count: 1 },
      { tool: 'grep', count: 1 },
    ])
    expect(derived.lastText).toBe('final answer')
    expect(derived.lastError).toBe('boom happened')
    expect(derived.activity.at(-1)?.glyph).toBe('◌')
    expect(derived.activity[0]?.glyph).toBe('✓')

    const fromSource = jobEventsFromSource(lines.join('\n'))
    expect(fromSource.toolCounts).toHaveLength(5)
    expect(toolCountsLine(fromSource.toolCounts)).toBe(
      'bash 3 · read 2 · edit 1 · glob 1 · grep 1',
    )
  })

  test('shows resolved effort in cards and header identity without inventing legacy effort', () => {
    const job = normalizeJob({ id: 'j_effort', status: 'running', model: 'model', effort: 'max' }, 'j_effort') as DshJob
    expect(job.effort).toBe('max')
    expect(jobMetaLine(job, 0)).toBe('model · effort max')
    expect(jobIdentity(job)).toBe('effort max · model')
    expect(normalizeJob({ id: 'j_old', effort: 9 }, 'j_old')?.effort).toBeUndefined()
    expect(jobMetaLine({ status: 'running' }, 0)).toBe('effort n/a')
  })

  test('builds the collapsed meta line, branch line and running freshness', () => {
    const job = {
      status: 'running',
      createdAt: '2026-10-20T15:00:00.000Z',
      startedAt: '2026-10-20T15:00:00.000Z',
      model: 'deepseek-flash',
      costUsd: 0.09,
      steps: 12,
      toolCalls: 18,
    }
    expect(jobMetaLine(job, Date.parse('2026-10-20T15:03:12.000Z'))).toBe(
      'deepseek-flash · effort n/a · 3m12s · $0.09 · 12 steps · 18 tools',
    )
    expect(branchLine({ branch: 'dsh/j_1', baseCommit: 'cc9791b1234' })).toBe(
      'dsh/j_1 @ cc9791b',
    )
    expect(
      branchLine({
        branch: 'dsh/j_1',
        baseCommit: 'cc9791b1234',
        cleaned: true,
      }),
    ).toBe('dsh/j_1 @ cc9791b (cleaned)')
    expect(eventsAgeMs({}, 1)).toBeUndefined()
    expect(eventsAgeMs({ eventsMtimeMs: 1_000 }, 4_000)).toBe(3_000)
    expect(
      isStalledRunning({ status: 'running', eventsMtimeMs: 0 }, 120_000),
    ).toBe(true)
    expect(
      isStalledRunning({ status: 'succeeded', eventsMtimeMs: 0 }, 120_000),
    ).toBe(false)
  })


  test('accepts only a #rrggbb pane background', () => {
    expect(paneBackground('#181818')).toBe('#181818')
    expect(paneBackground(' #1A1B1C ')).toBe('#1a1b1c')
    expect(paneBackground('')).toBeUndefined()
    expect(paneBackground('black')).toBeUndefined()
    expect(paneBackground('#fff')).toBeUndefined()
    expect(paneBackground(undefined)).toBeUndefined()
  })

  test('resolves the state dir with the documented precedence', () => {
    expect(
      resolveStateDir({
        option: '/opt/state',
        dedicated: '/env/state',
        xdgStateHome: '/xdg',
        home: '/home/u',
      }),
    ).toBe('/opt/state')
    expect(
      resolveStateDir({ dedicated: '/env/state', xdgStateHome: '/xdg' }),
    ).toBe('/env/state')
    expect(resolveStateDir({ xdgStateHome: '/xdg' })).toBe(
      '/xdg/agent-workers',
    )
    expect(resolveStateDir({ home: '/home/u' })).toBe(
      '/home/u/.local/state/agent-workers',
    )
    expect(resolveStateDir({ xdgStateHome: '/xdg', legacy: true })).toBe(
      '/xdg/dsh-workers',
    )
    expect(resolveStateDir({ home: '/home/u', legacy: true })).toBe(
      '/home/u/.local/state/dsh-workers',
    )
  })
})

// ---------------------------------------------------------------------------
// Integration tests: through the engine, with file-system and clock hooks
// ---------------------------------------------------------------------------

const HOME = '/home/test'
const STATE_DIR = `${HOME}/.local/state/agent-workers`
const FIXED_NOW = Date.UTC(2026, 9, 20, 15, 7, 36)

type FakeFile = { text: string; mtimeMs: number }
type FakeWorld = {
  stateDir: string
  jobIds: Set<string>
  files: Map<string, FakeFile>
  missingJobsDir: boolean
}

function createWorld(): FakeWorld {
  return {
    stateDir: STATE_DIR,
    jobIds: new Set(),
    files: new Map(),
    missingJobsDir: false,
  }
}

function jobsDir(world: FakeWorld): string {
  return `${world.stateDir}/jobs`
}

function jobPath(world: FakeWorld, id: string): string {
  return `${jobsDir(world)}/${id}/job.json`
}

function eventsPath(world: FakeWorld, id: string): string {
  return `${jobsDir(world)}/${id}/events.ndjson`
}

function finalPath(world: FakeWorld, id: string): string {
  return `${jobsDir(world)}/${id}/final.md`
}

function putFile(
  world: FakeWorld,
  path: string,
  text: string,
  mtimeMs: number,
): void {
  world.files.set(path, { text, mtimeMs })
}

function setJob(
  world: FakeWorld,
  id: string,
  fields: Record<string, unknown>,
  mtimeMs = 1,
): void {
  putFile(
    world,
    jobPath(world, id),
    JSON.stringify({
      id,
      cwd: '/repo',
      createdAt: '2026-10-20T15:00:00.000Z',
      ...fields,
    }),
    mtimeMs,
  )
}

function installFs(on: On, world: FakeWorld): void {
  on('fs.list', (_$, e) => {
    if (e.path !== jobsDir(world) || world.missingJobsDir) {
      throw new Error('ENOENT: no such file or directory')
    }
    return {
      value: [...world.jobIds].map(name => ({
        name,
        kind: 'dir' as const,
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })

  on('fs.stat', (_$, e) => {
    if (e.path === jobsDir(world)) {
      if (world.missingJobsDir) throw new Error('ENOENT')
      return {
        value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
      }
    }
    const file = world.files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return {
      value: {
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      },
    }
  })

  on('fs.read', (_$, e) => {
    const file = world.files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: file.text }
  })
}

type FakeMcpReply = McpToolResult

type McpCall = {
  server: string
  tool: string
  args: Record<string, unknown>
}

type Mocks = {
  clock: MockClock
  opens: Array<{ id: string; title?: string; columns?: number }>
  copies: Array<{ text: string; surface?: string }>
  mcpCalls: McpCall[]
  mcpReply: FakeMcpReply
  connectReply: McpConnectResult
  tools: Array<{ name: string; description: string; mcp: boolean }>
}

function installMocks(on: On, world: FakeWorld): Mocks {
  const clock = mock.clock(on, { now: FIXED_NOW })
  const opens: Mocks['opens'] = []
  const copies: Mocks['copies'] = []
  const mocks: Mocks = {
    clock,
    opens,
    copies,
    mcpCalls: [],
    mcpReply: { content: [{ type: 'text', text: '{}' }], isError: false },
    connectReply: {
      isConnected: true,
      server: 'plugin:agent-workers:agent-workers',
    },
    tools: [],
  }

  on('command.register', () => ({ value: { command: 'pane' } }))
  on('ui.open', (_$, e) => {
    opens.push({ id: e.id, title: e.title, columns: e.columns })
    return { value: { isPlaced: true } }
  })
  on('ui.copy', (_$, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('mcp.connect', () => ({ value: mocks.connectReply }))
  on('tool.list', () => ({ value: mocks.tools }))
  on('mcp.call', (_$, e) => {
    mocks.mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    return { value: mocks.mcpReply }
  })
  mock.env(on, { HOME })
  installFs(on, world)

  return mocks
}

const PANE = {
  plugin: 'agent-workers',
  component: 'Pane',
  requestId: 'agent-workers',
  surface: 'terminal',
  props: {
    title: 'Agent Workers',
    isFocused: false,
    bodyColumns: 58,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function mountPane($: Engine) {
  return $.ui.mount(PANE)
}

async function start($: Engine): Promise<void> {
  await $.session.start({
    cwd: '/repo',
    surface: 'terminal',
    isInteractive: true,
  })
}

test('initial load renders jobs', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'chat-auto-model',
    status: 'running',
    steps: 4,
    toolCalls: 7,
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  const row = await ui.find({ key: 'job:j_1' })
  expect(row).toBeDefined()
  expect(row?.text).toContain('chat-auto-model')
  expect(await ui.find({ type: 'Text', text: /◌ RUNNING/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◌ 1 running/ })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: /Updated \d\d:\d\d:\d\d/ }),
  ).toBeDefined()
  await ui.unmount()
})

test('missing jobs dir shows the empty message and resolved path', async ($, on) => {
  const world = createWorld()
  world.missingJobsDir = true
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /No worker jobs yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: world.stateDir })).toBeDefined()
  await ui.unmount()
})

test('invalid JSON keeps the last valid job and recovers on the next valid read', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', { label: 'stable-job', status: 'running' })
  const { clock } = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'job:j_1' })).toBeDefined()

  putFile(world, jobPath(world, 'j_1'), '{"id":"j_1","label":', 20)
  await clock.advance(1000)

  expect(await ui.find({ key: 'job:j_1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /invalid job\.json/ })).toBeDefined()

  setJob(
    world,
    'j_1',
    { label: 'recovered-job', status: 'succeeded' },
    30,
  )
  await clock.advance(1000)

  expect(await ui.find({ type: 'Text', text: /invalid job\.json/ })).toBeUndefined()
  const row = await ui.find({ key: 'job:j_1' })
  expect(row?.text).toContain('recovered-job')
  expect(await ui.find({ type: 'Text', text: /✓ SUCCEEDED/ })).toBeDefined()
  await ui.unmount()
})

test('a job appears and disappears between refreshes', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', { label: 'first-job', status: 'running' })
  const { clock } = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'job:j_1' })).toBeDefined()
  expect(await ui.find({ key: 'job:j_2' })).toBeUndefined()

  world.jobIds.add('j_2')
  setJob(world, 'j_2', { label: 'second-job', status: 'queued' })
  await clock.advance(1000)
  expect(await ui.find({ key: 'job:j_2' })).toBeDefined()

  world.jobIds.delete('j_2')
  world.files.delete(jobPath(world, 'j_2'))
  await clock.advance(1000)
  expect(await ui.find({ key: 'job:j_2' })).toBeUndefined()
  expect(await ui.find({ key: 'job:j_1' })).toBeDefined()
  await ui.unmount()
})

test('a running job becomes succeeded and shows final.md when expanded', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'transition-job',
    status: 'running',
    steps: 3,
    toolCalls: 2,
  })
  putFile(world, finalPath(world, 'j_1'), '## Summary\n\nAll good\n\nSecond line', 2)
  const { clock } = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /◌ RUNNING/ })).toBeDefined()

  setJob(
    world,
    'j_1',
    {
      label: 'transition-job',
      status: 'succeeded',
      steps: 3,
      toolCalls: 2,
      finishedAt: '2026-10-20T15:00:10.000Z',
    },
    10,
  )
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /✓ SUCCEEDED/ })).toBeDefined()

  await ui.press({ key: 'job:j_1' })
  expect(await ui.find({ type: 'Text', text: /3 steps · 2 tools/ })).toBeDefined()

  await clock.advance(1000)
  expect(
    await ui.find({ type: 'Markdown', text: /All good/ }),
  ).toBeDefined()
  await ui.unmount()
})

test('pressing a row expands it and expansion survives a refresh', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'activity-job',
    status: 'running',
    steps: 12,
    toolCalls: 5,
    startedAt: '2026-10-20T15:00:00.000Z',
  })
  putFile(
    world,
    eventsPath(world, 'j_1'),
    [
      '{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"pnpm test","description":"Run tests"}}',
      '{"type":"tool_result","callId":"c1","status":"completed","result":"ok"}',
      '{"type":"tool_call","callId":"c2","tool":"edit","input":{"file_path":"src/a.ts"}}',
    ].join('\n'),
    1,
  )
  const { clock } = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  expect((await ui.find({ key: 'job:j_1' }))?.text).toContain('▶ activity-job')

  await ui.press({ key: 'job:j_1' })
  expect((await ui.find({ key: 'job:j_1' }))?.text).toContain('▼ activity-job')
  expect(await ui.find({ type: 'Text', text: /12 steps · 5 tools/ })).toBeDefined()

  await clock.advance(1000)
  expect((await ui.find({ key: 'job:j_1' }))?.text).toContain('▼ activity-job')
  expect(await ui.find({ type: 'Text', text: /bash/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pnpm test/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /edit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/a\.ts/ })).toBeDefined()

  await clock.advance(1000)
  expect((await ui.find({ key: 'job:j_1' }))?.text).toContain('▼ activity-job')
  expect(await ui.find({ type: 'Text', text: /pnpm test/ })).toBeDefined()
  await ui.unmount()
})

test('two concurrent running jobs render and count as active', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  world.jobIds.add('j_2')
  setJob(world, 'j_1', { label: 'first-running', status: 'running' })
  setJob(world, 'j_2', { label: 'second-running', status: 'running' })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /◌ 2 running/ })).toBeDefined()
  expect((await ui.find({ key: 'job:j_1' }))?.text).toContain('first-running')
  expect((await ui.find({ key: 'job:j_2' }))?.text).toContain('second-running')
  await ui.unmount()
})

test('the filter toggle switches between this project and all jobs', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  world.jobIds.add('j_2')
  setJob(world, 'j_1', {
    label: 'project-job',
    status: 'running',
    groupName: 'alpha',
    cwd: '/state/worktrees/j_1',
    worktree: { repoRoot: '/repo' },
  })
  setJob(world, 'j_2', {
    label: 'other-job',
    status: 'running',
    groupName: 'beta',
    cwd: '/elsewhere',
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  expect(await ui.find({ key: 'job:j_1' })).toBeDefined()
  expect(await ui.find({ key: 'job:j_2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /◌ 1 running/ })).toBeDefined()

  await ui.press({ key: 'toggle-filter' })
  expect(await ui.find({ key: 'job:j_2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'alpha' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'beta' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◌ 2 running/ })).toBeDefined()

  await ui.press({ key: 'toggle-filter' })
  expect(await ui.find({ key: 'job:j_2' })).toBeUndefined()
  expect(await ui.find({ key: 'job:j_1' })).toBeDefined()
  await ui.unmount()
})

test('an expanded failed job shows reason, error and the last stderr lines', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'failed-job',
    status: 'failed',
    reason: 'turn_error',
    errorMessage: 'boom happened',
    stderrTail: 'line one\nline two\nline three\nline four',
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  await ui.press({ key: 'job:j_1' })
  const errorBox = await ui.find({ key: 'error:j_1' })
  expect(errorBox?.props.borderStyle).toBe('single')
  expect(errorBox?.props.borderColor).toBe('error')
  expect(await ui.find({ type: 'Text', text: /reason: turn_error/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /boom happened/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /stderr: line two/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /line four/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /line one/ })).toBeUndefined()
  await ui.unmount()
})

test('the header summarizes visible rows by status', async ($, on) => {
  const world = createWorld()
  const jobs: Array<[string, string]> = [
    ['j_r1', 'running'],
    ['j_r2', 'starting'],
    ['j_q', 'queued'],
    ['j_s1', 'succeeded'],
    ['j_s2', 'succeeded'],
    ['j_s3', 'succeeded'],
    ['j_s4', 'succeeded'],
    ['j_s5', 'succeeded'],
    ['j_f', 'failed'],
    ['j_t', 'timed_out'],
    ['j_i', 'interrupted'],
    ['j_c', 'cancelled'],
  ]
  for (const [id, status] of jobs) {
    world.jobIds.add(id)
    setJob(world, id, { label: id, status })
  }
  installMocks(on, world)

  await start($)
  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 120 },
  })

  expect(await ui.find({ type: 'Text', text: /◌ 2 running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /○ 1 queued/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗ 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 1 interrupted/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /− 1 cancelled/ })).toBeDefined()
  await ui.unmount()
})

test('a running alert card shows warning text and a warning border', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'alert-job',
    status: 'running',
    alerts: [
      {
        kind: 'loop',
        message: 'same bash call repeated 5× in last 10',
        since: '2026-10-20T15:07:36.000Z',
      },
    ],
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  const alerts = await ui.findAll({
    type: 'Text',
    text: /⚠ loop · same bash call repeated 5× in last 10/,
  })
  expect(alerts.some(item => item.props.color === 'warning')).toBe(true)
  const card = await ui.find({ key: 'j_1' })
  expect(card?.props.borderColor).toBe('warning')
  await ui.unmount()
})

test('a terminal alert card keeps its status border but still shows the alert', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'finished-alert-job',
    status: 'succeeded',
    alerts: [
      {
        kind: 'tool_errors',
        message: '5 tool errors in last 10 results',
        since: '2026-10-20T15:07:36.000Z',
      },
    ],
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  const alerts = await ui.findAll({
    type: 'Text',
    text: /⚠ tool_errors · 5 tool errors in last 10 results/,
  })
  expect(alerts.some(item => item.props.color === 'warning')).toBe(true)
  const card = await ui.find({ key: 'j_1' })
  expect(card?.props.borderColor).toBe('success')
  await ui.unmount()
})

test('the collapsed card shows model, duration, cost, steps and tools', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'meta-job',
    status: 'running',
    model: 'deepseek-flash',
    startedAt: '2026-10-20T15:00:00.000Z',
    costUsd: 0.09,
    steps: 12,
    toolCalls: 18,
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  expect(
    await ui.find({
      type: 'Text',
      text: truncateLine('deepseek-flash · effort n/a · 7m36s · $0.09 · 12 steps · 18 tools', PANE.props.bodyColumns - 4),
    }),
  ).toBeDefined()
  await ui.unmount()
})

test('a running job with an old last event shows the stalled warning', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'stalled-job',
    status: 'running',
    startedAt: '2026-10-20T15:00:00.000Z',
  })
  putFile(
    world,
    eventsPath(world, 'j_1'),
    '{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"pnpm test"}}',
    FIXED_NOW - 120_000,
  )
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /bash/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pnpm test/ })).toBeDefined()
  const warnings = await ui.findAll({
    type: 'Text',
    text: /no events for 2m/,
  })
  expect(warnings.some(item => item.props.color === 'warning')).toBe(true)
  await ui.unmount()
})

test('an expanded succeeded job renders Markdown and toggles more/less', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'result-job',
    status: 'succeeded',
    startedAt: '2026-10-20T15:00:00.000Z',
    finishedAt: '2026-10-20T15:03:12.000Z',
  })
  const lines: string[] = []
  for (let index = 1; index <= 20; index += 1) {
    lines.push(`line ${index}`)
  }
  putFile(world, finalPath(world, 'j_1'), lines.join('\n'), 2)
  putFile(
    world,
    eventsPath(world, 'j_1'),
    [
      '{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"pnpm test"}}',
      '{"type":"tool_result","callId":"c1","status":"completed"}',
      '{"type":"tool_call","callId":"c2","tool":"edit","input":{"file_path":"src/a.ts"}}',
    ].join('\n'),
    2,
  )
  const { clock } = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await clock.advance(1000)

  expect(await ui.find({ type: 'Text', text: /bash 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /edit 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pnpm test/ })).toBeDefined()
  const preview = await ui.find({ type: 'Markdown' })
  expect(preview?.text).toContain('line 1')
  expect(preview?.text).toContain('line 14')
  expect(preview?.text).not.toContain('line 15')
  expect((await ui.find({ key: 'final:j_1' }))?.text).toBe('more')

  await ui.press({ key: 'final:j_1' })
  const full = await ui.find({ type: 'Markdown' })
  expect(full?.text).toContain('line 20')
  expect((await ui.find({ key: 'final:j_1' }))?.text).toBe('less')

  await ui.press({ key: 'final:j_1' })
  expect((await ui.find({ type: 'Markdown' }))?.text).not.toContain('line 15')
  await ui.unmount()
})

test('header keeps effort visible at normal width with real long profile/model names', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'long-identity',
    status: 'succeeded',
    profile: 'work-openrouter',
    provider: 'openrouter',
    model: '~deepseek/deepseek-flash-latest',
    effort: 'max',
    usage: { totalTokens: 2670379 },
    costUsd: 0.42,
  })
  installMocks(on, world)
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^effort max · work-openrouter/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$0.42' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2.7M tok' })).toBeDefined()
  await ui.unmount()
})

test('an expanded job shows details, tokens and the header totals', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'detail-job',
    status: 'succeeded',
    profile: 'personal-deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    access: 'workspace-write',
    isolation: 'worktree',
    worktree: {
      branch: 'dsh/j_1',
      baseCommit: 'cc9791b1234',
      repoRoot: '/repo',
      cleaned: true,
    },
    groupName: 'alpha',
    startedAt: '2026-10-20T15:00:00.000Z',
    finishedAt: '2026-10-20T15:03:12.000Z',
    turnEndKind: 'completed',
    malformedLines: 2,
    usage: {
      inputTokens: 81600,
      outputTokens: 21800,
      totalTokens: 2670379,
      cacheReadTokens: 2500000,
      cacheWriteTokens: 1200,
      reasoningTokens: 300,
    },
    costUsd: 0.42,
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)

  expect(
    await ui.find({ type: 'Text', text: new RegExp('^effort n/a · personal-deepseek') }),
  ).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2.7M tok' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$0.42' })).toBeDefined()

  await ui.press({ key: 'job:j_1' })
  expect(
    await ui.find({ type: 'Text', text: /personal-deepseek \/ deepseek/ }),
  ).toBeDefined()
  const writeTexts = await ui.findAll({ type: 'Text', text: 'write' })
  expect(writeTexts.some(item => item.props.color === 'warning')).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'worktree' })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: /dsh\/j_1 @ cc9791b \(cleaned\)/ }),
  ).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /turn end/ })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: /⚠ 2 malformed lines/ }),
  ).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '81.6k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '21.8k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2.5M' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '(97% hit)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1.2k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '300' })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: 'no final.md' }),
  ).toBeDefined()
  await ui.unmount()
})

test('copy buttons call ui.copy with the press surface', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'copy-job',
    status: 'succeeded',
    worktree: {
      branch: 'dsh/j_1',
      baseCommit: 'cc9791b1234',
      repoRoot: '/repo',
    },
  })
  const { clock, copies } = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })

  await ui.press({ key: 'copy-id:j_1' })
  await clock.settle()
  expect(copies.at(-1)).toEqual({ text: 'j_1', surface: 'terminal' })

  await ui.press({ key: 'copy-branch:j_1' })
  await clock.settle()
  expect(copies.at(-1)).toEqual({ text: 'dsh/j_1', surface: 'terminal' })
  await ui.unmount()
})

test('/pane calls ui.open', async ($, on) => {
  const world = createWorld()
  const { clock, opens } = installMocks(on, world)

  await start($)
  await clock.settle()
  const before = opens.length

  const result = await $.command.run({
    command: 'pane',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(result).toEqual({})
  expect(opens.length).toBe(before + 1)
  expect(opens.at(-1)?.id).toBe('agent-workers')
  expect(opens.at(-1)?.columns).toBe(58)
})

function actionJob(
  world: FakeWorld,
  fields: Record<string, unknown> = {},
): void {
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'action-job',
    status: 'succeeded',
    worktree: {
      branch: 'dsh/j_1',
      baseCommit: 'cc9791b1234',
      repoRoot: '/repo',
    },
    ...fields,
  })
}

test('resolves a namespaced server through the connected tool list', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)
  mocks.connectReply = {
    isConnected: false,
    reason: 'unlisted',
    message: 'not listed in this session',
  }
  mocks.tools = [
    {
      name: 'mcp__plugin_agent-workers_agent-workers__worker_delete',
      description: 'Delete a worker',
      mcp: true,
    },
  ]

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.settle()

  expect(mocks.mcpCalls[0]?.server).toBe('plugin_agent-workers_agent-workers')
  await ui.unmount()
})

test('delete needs a second press and never calls on the first', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })

  expect(await ui.find({ key: 'delete:j_1' })).toBeDefined()
  expect(await ui.find({ key: 'cleanup:j_1' })).toBeDefined()

  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls).toHaveLength(0)
  expect((await ui.find({ key: 'delete:j_1' }))?.text).toContain(
    'confirm delete?',
  )

  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.advance(1000)
  expect(mocks.mcpCalls).toHaveLength(1)
  expect(mocks.mcpCalls[0]).toMatchObject({
    tool: 'worker_delete',
    args: { job_id: 'j_1', discard_changes: false },
  })
  expect(await ui.find({ type: 'Text', text: 'deleted' })).toBeDefined()

  world.jobIds.delete('j_1')
  world.files.delete(jobPath(world, 'j_1'))
  await mocks.clock.advance(1000)
  expect(await ui.find({ key: 'job:j_1' })).toBeUndefined()
  await ui.unmount()
})

test('an expired confirm is a new first press', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.advance(6000)

  expect(await ui.find({ key: 'delete:j_1' })).toBeDefined()
  expect((await ui.find({ key: 'delete:j_1' }))?.text).toBe('delete')
  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls).toHaveLength(0)
  expect((await ui.find({ key: 'delete:j_1' }))?.text).toContain(
    'confirm delete?',
  )
  await ui.unmount()
})

test('cleanup cleans a terminal worktree and keeps the record', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)
  mocks.mcpReply = {
    content: [{ type: 'text', text: JSON.stringify({ worktree: 'removed' }) }],
    isError: false,
  }

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await ui.press({ key: 'cleanup:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls).toHaveLength(0)
  expect((await ui.find({ key: 'cleanup:j_1' }))?.text).toContain(
    'confirm cleanup?',
  )

  await ui.press({ key: 'cleanup:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls[0]).toMatchObject({
    tool: 'worker_cleanup',
    args: { job_id: 'j_1', discard_changes: false },
  })
  expect(await ui.find({ type: 'Text', text: 'cleaned' })).toBeDefined()
  await ui.unmount()
})

test('a dirty delete offers discard & delete behind its own confirm', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)
  mocks.mcpReply = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'worktree_dirty',
          message: 'worktree has uncommitted changes',
        }),
      },
    ],
    isError: true,
  }

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls).toHaveLength(1)
  expect(
    await ui.find({ type: 'Text', text: 'worktree has changes' }),
  ).toBeDefined()
  expect(await ui.find({ key: 'discard-delete:j_1' })).toBeDefined()

  mocks.mcpReply = {
    content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }],
    isError: false,
  }
  await ui.press({ key: 'discard-delete:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls).toHaveLength(1)
  expect((await ui.find({ key: 'discard-delete:j_1' }))?.text).toContain(
    'confirm discard?',
  )

  await ui.press({ key: 'discard-delete:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls).toHaveLength(2)
  expect(mocks.mcpCalls[1]).toMatchObject({
    tool: 'worker_delete',
    args: { job_id: 'j_1', discard_changes: true },
  })
  await ui.unmount()
})

test('a preserved dirty cleanup offers discard & clean', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)
  mocks.mcpReply = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ job_id: 'j_1', worktree: 'preserved_dirty' }),
      },
    ],
    isError: false,
  }

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await ui.press({ key: 'cleanup:j_1' })
  await ui.press({ key: 'cleanup:j_1' })
  await mocks.clock.settle()
  expect(
    await ui.find({ type: 'Text', text: 'worktree has changes' }),
  ).toBeDefined()
  expect(await ui.find({ key: 'discard-clean:j_1' })).toBeDefined()
  await ui.press({ key: 'discard-clean:j_1' })
  await ui.press({ key: 'discard-clean:j_1' })
  await mocks.clock.settle()
  expect(mocks.mcpCalls.at(-1)).toMatchObject({
    tool: 'worker_cleanup',
    args: { job_id: 'j_1', discard_changes: true },
  })
  await ui.unmount()
})

test('an action error is shown truncated on the card', async ($, on) => {
  const world = createWorld()
  actionJob(world)
  const mocks = installMocks(on, world)
  mocks.mcpReply = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'job_active',
          message: 'cannot delete an active job',
        }),
      },
    ],
    isError: true,
  }

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await ui.press({ key: 'delete:j_1' })
  await mocks.clock.settle()

  const result = await ui.find({
    type: 'Text',
    text: /cannot delete an active job/,
  })
  expect(result?.props.color).toBe('error')
  await ui.unmount()
})

test('active jobs never show cleanup or delete', async ($, on) => {
  const world = createWorld()
  world.jobIds.add('j_1')
  setJob(world, 'j_1', {
    label: 'running-job',
    status: 'running',
    worktree: {
      branch: 'dsh/j_1',
      baseCommit: 'cc9791b1234',
      repoRoot: '/repo',
    },
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })

  expect(await ui.find({ key: 'delete:j_1' })).toBeUndefined()
  expect(await ui.find({ key: 'cleanup:j_1' })).toBeUndefined()
  await ui.unmount()
})

test('a cleaned worktree hides cleanup but keeps delete', async ($, on) => {
  const world = createWorld()
  actionJob(world, {
    worktree: {
      branch: 'dsh/j_1',
      baseCommit: 'cc9791b1234',
      repoRoot: '/repo',
      cleaned: true,
    },
  })
  installMocks(on, world)

  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'job:j_1' })

  expect(await ui.find({ key: 'cleanup:j_1' })).toBeUndefined()
  expect(await ui.find({ key: 'delete:j_1' })).toBeDefined()
  await ui.unmount()
})

test('unrelated panes pass through', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine pane</Text>
  })

  const ui = await $.ui.mount({ ...PANE, requestId: 'other' })
  expect(
    (await ui.find({ type: 'Text', text: /engine pane/ }))?.text,
  ).toBe('engine pane')
  await ui.unmount()
})
