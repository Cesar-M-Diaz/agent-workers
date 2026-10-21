import { StringDecoder } from 'node:string_decoder';

import { type FoldedRun, stableStringify } from '../ndjson.js';
import type { Usage } from '../types.js';
import type { Fold } from './types.js';

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const TOOL_WINDOW = 10;
const RESULT_WINDOW = 10;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function addUsage(current: Usage | undefined, next: Usage): Usage {
  const base = current ?? {};
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (next.totalTokens ?? 0),
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    reasoningTokens: (base.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  };
}

function mapUsage(raw: unknown): { usage: Usage; costUsd?: number } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const usage: Usage = {
    ...(num(value.input) !== undefined ? { inputTokens: num(value.input) } : {}),
    ...(num(value.output) !== undefined ? { outputTokens: num(value.output) } : {}),
    ...(num(value.totalTokens) !== undefined ? { totalTokens: num(value.totalTokens) } : {}),
    ...(num(value.cacheRead) !== undefined ? { cacheReadTokens: num(value.cacheRead) } : {}),
    ...(num(value.cacheWrite) !== undefined ? { cacheWriteTokens: num(value.cacheWrite) } : {}),
    ...(num(value.reasoning) !== undefined ? { reasoningTokens: num(value.reasoning) } : {}),
  };
  if (Object.keys(usage).length === 0) return undefined;
  const cost = value.cost;
  const total =
    cost !== null && typeof cost === 'object'
      ? num((cost as Record<string, unknown>).total)
      : undefined;
  return { usage, ...(total !== undefined ? { costUsd: total } : {}) };
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block) =>
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function mapStopReason(reason: unknown): string | undefined {
  switch (reason) {
    case 'stop':
      return 'completed';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return undefined;
  }
}

/**
 * Turns pi's JSON/RPC event stream into the normalized event shape the pane
 * and the job manager already consume. Raw pi events are never persisted.
 */
export class PiFold implements Fold {
  readonly state: FoldedRun = {
    malformedLines: 0,
    eventsCount: 0,
    toolCalls: 0,
    steps: 0,
    recentToolCalls: [],
    recentToolResults: [],
  };

  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private lastAssistantText = '';

  constructor(private readonly onEvent?: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    this.drain(false);
  }

  end(): FoldedRun {
    this.buffer += this.decoder.end();
    this.drain(true);
    return this.state;
  }

  private emit(event: Record<string, unknown>): void {
    this.onEvent?.(JSON.stringify(event));
  }

  private drain(atEnd: boolean): void {
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consume(line);
      newline = this.buffer.indexOf('\n');
    }
    if (atEnd && this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      this.consume(line);
    }
  }

  private consume(line: string): void {
    if (line.trim() === '') return;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      this.state.malformedLines += 1;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.state.malformedLines += 1;
      return;
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      this.state.malformedLines += 1;
      return;
    }
    this.fold(event as Record<string, unknown>);
  }

  private fold(event: Record<string, unknown>): void {
    this.state.eventsCount += 1;
    this.state.lastEventAt = Date.now();
    const type = typeof event.type === 'string' ? event.type : '';

    switch (type) {
      case 'session':
        if (typeof event.id === 'string') {
          this.state.sessionId = event.id;
          this.emit({ type: 'session', sessionId: event.id });
        }
        return;
      case 'turn_start':
        this.state.steps += 1;
        this.emit({ type: 'status', phase: 'step_start' });
        return;
      case 'message_update': {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (update && update.type === 'text_end' && typeof update.content === 'string') {
          this.emit({ type: 'text', text: update.content });
        }
        return;
      }
      case 'message_end': {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role !== 'assistant') return;
        const text = textBlocks(message.content);
        if (text) this.lastAssistantText = text;
        if (message.stopReason === 'error') {
          const error =
            (typeof message.errorMessage === 'string' && message.errorMessage.trim()) ||
            text ||
            'pi turn ended with error';
          this.state.errorMessage = error;
          this.emit({ type: 'error', message: error });
        }
        return;
      }
      case 'auto_retry_start':
        // The failed attempt is being retried automatically; do not fail the
        // job for an error that pi may recover from.
        this.state.errorMessage = undefined;
        return;
      case 'auto_retry_end': {
        if (event.success === true) {
          this.state.errorMessage = undefined;
        } else if (typeof event.finalError === 'string' && event.finalError.trim()) {
          this.state.errorMessage = event.finalError;
          this.emit({ type: 'error', message: event.finalError });
        }
        return;
      }
      case 'agent_end':
        if (event.willRetry === true) this.state.errorMessage = undefined;
        return;
      case 'tool_execution_start': {
        const tool = typeof event.toolName === 'string' ? event.toolName : 'tool';
        this.state.toolCalls += 1;
        this.state.lastTool = tool;
        this.state.recentToolCalls.push({ tool, input: stableStringify(event.args) });
        if (this.state.recentToolCalls.length > TOOL_WINDOW) this.state.recentToolCalls.shift();
        this.emit({
          type: 'tool_call',
          callId: event.toolCallId,
          tool,
          input: event.args,
        });
        return;
      }
      case 'tool_execution_end': {
        const status = event.isError === true ? 'failed' : 'completed';
        this.state.recentToolResults.push(status);
        if (this.state.recentToolResults.length > RESULT_WINDOW)
          this.state.recentToolResults.shift();
        this.emit({ type: 'tool_result', callId: event.toolCallId, status });
        return;
      }
      case 'turn_end': {
        const message = event.message as Record<string, unknown> | undefined;
        const mapped = mapUsage(message?.usage);
        if (mapped) {
          this.state.usage = addUsage(this.state.usage, mapped.usage);
          if (mapped.costUsd !== undefined) {
            this.state.costUsd = (this.state.costUsd ?? 0) + mapped.costUsd;
          }
        }
        const kind = mapStopReason(message?.stopReason);
        if (kind) this.state.turnEndKind = kind;
        this.emit({
          type: 'status',
          phase: 'step_end',
          ...(mapped ? { usage: mapped.usage } : {}),
        });
        if (kind) this.emit({ type: 'status', phase: 'turn_end', reason: kind });
        return;
      }
      case 'agent_settled': {
        if (event.aborted === true) {
          this.state.turnEndKind = 'aborted';
          return;
        }
        if (
          (this.state.turnEndKind === 'completed' || this.state.turnEndKind === 'length') &&
          this.lastAssistantText !== ''
        ) {
          this.state.finalText = this.lastAssistantText;
          this.emit({ type: 'final', text: this.lastAssistantText });
        }
        return;
      }
      case 'error': {
        const error = typeof event.message === 'string' ? event.message : 'pi error';
        this.state.errorMessage = error;
        this.emit({ type: 'error', message: error });
        return;
      }
      default:
        return;
    }
  }
}
