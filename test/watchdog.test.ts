import { describe, expect, it } from 'vitest';
import { NdjsonFold } from '../src/ndjson.js';
import { computeAlerts, type WatchdogOptions } from '../src/watchdog.js';

const event = (value: unknown) => `${JSON.stringify(value)}\n`;

const OPTIONS: WatchdogOptions = {
  stallMs: 120_000,
  loopRepeat: 4,
  toolErrorLimit: 5,
  action: 'warn',
};

function foldLines(lines: readonly unknown[]): NdjsonFold {
  const fold = new NdjsonFold();
  fold.push(Buffer.from(lines.map(event).join('')));
  return fold;
}

function toolCall(tool: string, input: unknown, callId: string) {
  return { type: 'tool_call', tool, callId, input };
}

describe('watchdog alerts', () => {
  it('warns when no event arrives for longer than the stall window and clears on an event', () => {
    const fold = foldLines([{ type: 'session', sessionId: 's1' }]);
    const now = Date.now();
    fold.state.lastEventAt = now - 180_000;
    const alerts = computeAlerts(fold.state, OPTIONS, { now });
    expect(alerts).toEqual([
      {
        kind: 'stalled',
        message: 'no events for 3m',
        since: new Date(now - 60_000).toISOString(),
      },
    ]);

    fold.push(Buffer.from(event({ type: 'status', phase: 'step_start' })));
    expect(computeAlerts(fold.state, OPTIONS, { now: Date.now() })).toEqual([]);
  });

  it('detects a repeated tool call with identical input and clears when it leaves the window', () => {
    const fold = foldLines([
      toolCall('bash', { command: 'pnpm test', timeout: 30 }, 'c1'),
      toolCall('bash', { timeout: 30, command: 'pnpm test' }, 'c2'),
      toolCall('bash', { command: 'pnpm test', timeout: 30 }, 'c3'),
      toolCall('bash', { command: 'pnpm test', timeout: 30 }, 'c4'),
    ]);
    const alert = computeAlerts(fold.state, OPTIONS, { now: Date.now() })[0];
    expect(alert?.kind).toBe('loop');
    expect(alert?.message).toBe('same bash call repeated 4× in last 4');

    for (let index = 0; index < 7; index += 1) {
      fold.push(
        Buffer.from(event(toolCall('read', { file_path: `src/${index}.ts` }, `r${index}`))),
      );
    }
    expect(
      computeAlerts(fold.state, OPTIONS, { now: Date.now() }).some((item) => item.kind === 'loop'),
    ).toBe(false);
  });

  it('detects repeated tool failures within the last ten results and clears them', () => {
    const fold = foldLines(
      Array.from({ length: 5 }, (_, index) => ({
        type: 'tool_result',
        callId: `c${index}`,
        status: 'error',
      })),
    );
    expect(computeAlerts(fold.state, OPTIONS, { now: Date.now() })[0]).toMatchObject({
      kind: 'tool_errors',
      message: '5 tool errors in last 5 results',
    });

    for (let index = 0; index < 10; index += 1) {
      fold.push(
        Buffer.from(event({ type: 'tool_result', callId: `ok${index}`, status: 'completed' })),
      );
    }
    expect(
      computeAlerts(fold.state, OPTIONS, { now: Date.now() }).some(
        (item) => item.kind === 'tool_errors',
      ),
    ).toBe(false);
  });

  it('warns on the step and cost budgets only when they are configured', () => {
    const fold = foldLines([
      { type: 'status', phase: 'step_start' },
      { type: 'status', phase: 'step_start' },
      { type: 'status', phase: 'step_start' },
    ]);
    const now = Date.now();
    expect(computeAlerts(fold.state, { ...OPTIONS, maxSteps: 2 }, { now })[0]).toMatchObject({
      kind: 'budget',
      message: '3 steps exceeds limit 2',
    });
    expect(
      computeAlerts(fold.state, { ...OPTIONS, maxCostUsd: 0.1 }, { now, costUsd: 0.25 })[0],
    ).toMatchObject({ kind: 'budget', message: 'estimated $0.2500 exceeds $0.1000' });
    expect(computeAlerts(fold.state, OPTIONS, { now })).toEqual([]);
  });

  it('keeps the since timestamp while an alert persists', () => {
    const fold = foldLines([
      toolCall('bash', { command: 'pnpm test' }, 'c1'),
      toolCall('bash', { command: 'pnpm test' }, 'c2'),
      toolCall('bash', { command: 'pnpm test' }, 'c3'),
      toolCall('bash', { command: 'pnpm test' }, 'c4'),
    ]);
    const first = computeAlerts(fold.state, OPTIONS, { now: 1_000 });
    const second = computeAlerts(fold.state, OPTIONS, {
      now: 2_000,
      previous: first,
    });
    expect(second[0]?.since).toBe(first[0]?.since);
    expect(new Date(second[0]?.since ?? 0).toISOString()).toBe(new Date(1_000).toISOString());
  });

  it('reports budget and errors together in a stable order', () => {
    const fold = foldLines([
      { type: 'status', phase: 'step_start' },
      { type: 'status', phase: 'step_start' },
      { type: 'tool_result', callId: 'c1', status: 'error' },
    ]);
    const alerts = computeAlerts(
      fold.state,
      { ...OPTIONS, maxSteps: 1, toolErrorLimit: 1 },
      { now: Date.now() },
    );
    expect(alerts.map((alert) => alert.kind)).toEqual(['tool_errors', 'budget']);
  });
});
