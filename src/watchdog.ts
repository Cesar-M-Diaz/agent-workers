import type { FoldedRun } from './ndjson.js';
import type { AlertKind, JobAlert } from './types.js';

export interface WatchdogOptions {
  /** Alert when no event arrived for longer than this. */
  stallMs: number;
  /** Identical tool calls needed to call a loop. */
  loopRepeat: number;
  /** Non-completed tool results needed to call tool_errors. */
  toolErrorLimit: number;
  /** Off when undefined. */
  maxSteps?: number;
  /** Off when undefined. */
  maxCostUsd?: number;
  action: 'warn' | 'cancel';
}

export interface AlertInput {
  now: number;
  costUsd?: number;
  /** Prior alerts, so an alert's `since` does not move while it persists. */
  previous?: readonly JobAlert[];
  /** Activity anchor before the first event (start time or creation time). */
  activeSince?: number;
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function keepSince(previous: readonly JobAlert[], kind: AlertKind, fallback: number): string {
  return previous.find((alert) => alert.kind === kind)?.since ?? new Date(fallback).toISOString();
}

function loopAlert(
  state: FoldedRun,
  options: WatchdogOptions,
  previous: readonly JobAlert[],
  now: number,
): JobAlert | undefined {
  const counts = new Map<string, { tool: string; count: number }>();
  for (const call of state.recentToolCalls) {
    const key = `${call.tool}\u0000${call.input}`;
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { tool: call.tool, count: 1 });
    else entry.count += 1;
  }
  let repeated: { tool: string; count: number } | undefined;
  for (const entry of counts.values()) {
    if (entry.count < options.loopRepeat) continue;
    if (repeated === undefined || entry.count > repeated.count) repeated = entry;
  }
  if (repeated === undefined) return undefined;
  return {
    kind: 'loop',
    message: `same ${repeated.tool} call repeated ${repeated.count}× in last ${state.recentToolCalls.length}`,
    since: keepSince(previous, 'loop', now),
  };
}

function toolErrorAlert(
  state: FoldedRun,
  options: WatchdogOptions,
  previous: readonly JobAlert[],
  now: number,
): JobAlert | undefined {
  const failed = state.recentToolResults.filter((status) => status !== 'completed').length;
  if (failed < options.toolErrorLimit) return undefined;
  return {
    kind: 'tool_errors',
    message: `${failed} tool errors in last ${state.recentToolResults.length} results`,
    since: keepSince(previous, 'tool_errors', now),
  };
}

function budgetAlert(
  state: FoldedRun,
  options: WatchdogOptions,
  input: AlertInput,
): JobAlert | undefined {
  if (options.maxSteps !== undefined && state.steps > options.maxSteps) {
    return {
      kind: 'budget',
      message: `${state.steps} steps exceeds limit ${options.maxSteps}`,
      since: keepSince(input.previous ?? [], 'budget', input.now),
    };
  }
  if (
    options.maxCostUsd !== undefined &&
    input.costUsd !== undefined &&
    input.costUsd > options.maxCostUsd
  ) {
    return {
      kind: 'budget',
      message: `estimated $${input.costUsd.toFixed(4)} exceeds $${options.maxCostUsd.toFixed(4)}`,
      since: keepSince(input.previous ?? [], 'budget', input.now),
    };
  }
  return undefined;
}

/**
 * Recompute the current alerts for one run. This is pure: it reads the folded
 * run plus thresholds and returns only alerts that are true right now, reusing
 * `previous` timestamps for alerts that are still present.
 */
export function computeAlerts(
  state: FoldedRun,
  options: WatchdogOptions,
  input: AlertInput,
): JobAlert[] {
  const previous = input.previous ?? [];
  const alerts: JobAlert[] = [];

  const lastActivity = state.lastEventAt ?? input.activeSince;
  if (lastActivity !== undefined && input.now - lastActivity > options.stallMs) {
    alerts.push({
      kind: 'stalled',
      message: `no events for ${formatAge(input.now - lastActivity)}`,
      since: keepSince(previous, 'stalled', lastActivity + options.stallMs),
    });
  }

  const loop = loopAlert(state, options, previous, input.now);
  if (loop !== undefined) alerts.push(loop);
  const toolErrors = toolErrorAlert(state, options, previous, input.now);
  if (toolErrors !== undefined) alerts.push(toolErrors);
  const budget = budgetAlert(state, options, input);
  if (budget !== undefined) alerts.push(budget);

  return alerts;
}
