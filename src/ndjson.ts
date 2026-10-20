import { StringDecoder } from 'node:string_decoder';
import type { Usage } from './types.js';

const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface FoldedRun {
  sessionId?: string;
  finalText?: string;
  turnEndKind?: string;
  errorMessage?: string;
  malformedLines: number;
  eventsCount: number;
  toolCalls: number;
  steps: number;
  lastTool?: string;
  lastEventAt?: number;
  usage?: Usage;
}

function addUsage(current: Usage | undefined, next: unknown): Usage | undefined {
  if (next === null || typeof next !== 'object') return current;
  const value = next as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof value[key] === 'number' && Number.isFinite(value[key])
      ? (value[key] as number)
      : undefined;
  const inputTokens = num('inputTokens');
  const outputTokens = num('outputTokens');
  const totalTokens = num('totalTokens');
  const cacheReadTokens = num('cacheReadTokens');
  const cacheWriteTokens = num('cacheWriteTokens');
  const reasoningTokens = num('reasoningTokens');
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return current;
  }
  const base: Usage = current ?? {};
  return {
    inputTokens: (base.inputTokens ?? 0) + (inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (outputTokens ?? 0),
    ...(base.totalTokens !== undefined || totalTokens !== undefined
      ? { totalTokens: (base.totalTokens ?? 0) + (totalTokens ?? 0) }
      : {}),
    ...(base.cacheReadTokens !== undefined || cacheReadTokens !== undefined
      ? { cacheReadTokens: (base.cacheReadTokens ?? 0) + (cacheReadTokens ?? 0) }
      : {}),
    ...(base.cacheWriteTokens !== undefined || cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (cacheWriteTokens ?? 0) }
      : {}),
    ...(base.reasoningTokens !== undefined || reasoningTokens !== undefined
      ? { reasoningTokens: (base.reasoningTokens ?? 0) + (reasoningTokens ?? 0) }
      : {}),
  };
}

/** Incremental parser/folder for `dsh --profile headless --json` output. */
export class NdjsonFold {
  readonly state: FoldedRun = {
    malformedLines: 0,
    eventsCount: 0,
    toolCalls: 0,
    steps: 0,
  };

  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private readonly onLine?: (line: string) => void;

  constructor(onLine?: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    this.drain(false);
  }

  end(): FoldedRun {
    this.buffer += this.decoder.end();
    this.drain(true);
    return this.state;
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
    this.onLine?.(line);
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
        if (typeof event.sessionId === 'string') this.state.sessionId = event.sessionId;
        return;
      case 'final':
        if (typeof event.text === 'string') this.state.finalText = event.text;
        return;
      case 'error':
        if (typeof event.message === 'string') this.state.errorMessage = event.message;
        else if (typeof event.code === 'string') this.state.errorMessage = event.code;
        return;
      case 'tool_call':
        this.state.toolCalls += 1;
        if (typeof event.tool === 'string') this.state.lastTool = event.tool;
        return;
      case 'status': {
        const phase = typeof event.phase === 'string' ? event.phase : '';
        if (phase === 'step_start') this.state.steps += 1;
        if (phase === 'step_end') this.state.usage = addUsage(this.state.usage, event.usage);
        if (phase === 'turn_end') {
          const reason = event.reason;
          if (typeof reason === 'string') this.state.turnEndKind = reason;
          else if (reason !== null && typeof reason === 'object') {
            const kind = (reason as Record<string, unknown>).kind;
            if (typeof kind === 'string') this.state.turnEndKind = kind;
          }
        }
        return;
      }
      default:
        return;
    }
  }
}
