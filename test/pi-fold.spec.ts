import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PiFold } from '../src/engines/pi-fold.js';

function run(file: string) {
  const text = readFileSync(`test/fixtures/pi/${file}`, 'utf8');
  const emitted: Array<Record<string, unknown>> = [];
  const fold = new PiFold((line) => emitted.push(JSON.parse(line) as Record<string, unknown>));
  fold.push(Buffer.from(text));
  const state = fold.end();
  return { state, emitted };
}

describe('PiFold', () => {
  it('folds a successful pi run into the normalized schema', () => {
    const { state, emitted } = run('json-basic.jsonl');

    expect(state.sessionId).toBe('fixture-session');
    expect(state.steps).toBe(2);
    expect(state.toolCalls).toBe(1);
    expect(state.lastTool).toBe('bash');
    expect(state.recentToolResults).toEqual(['completed']);
    expect(state.finalText).toBe('hi');
    expect(state.turnEndKind).toBe('completed');
    expect(state.errorMessage).toBeUndefined();
    expect(state.malformedLines).toBe(0);
    expect(state.eventsCount).toBeGreaterThan(10);
    expect(state.lastEventAt).toBeTypeOf('number');
    expect(state.usage).toMatchObject({
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(state.costUsd).toBeCloseTo(0.0005, 8);

    expect(emitted.map((event) => event.type)).toEqual([
      'session',
      'status',
      'tool_call',
      'tool_result',
      'status',
      'status',
      'text',
      'status',
      'status',
      'final',
    ]);
    const toolCall = emitted.find((event) => event.type === 'tool_call');
    expect(toolCall).toMatchObject({
      callId: 'call_1',
      tool: 'bash',
      input: { command: 'printf hi' },
    });
    expect(emitted.at(-1)).toEqual({ type: 'final', text: 'hi' });
  });

  it('does not emit a final answer for an aborted run', () => {
    const { state, emitted } = run('json-aborted.jsonl');
    expect(state.sessionId).toBe('fixture-aborted');
    expect(state.turnEndKind).toBe('aborted');
    expect(state.finalText).toBeUndefined();
    expect(state.errorMessage).toBe('pi turn ended with error');
    expect(emitted.some((event) => event.type === 'final')).toBe(false);
    expect(emitted.some((event) => event.type === 'error')).toBe(true);
  });

  it('clears a transient error after a successful auto-retry', () => {
    const { state, emitted } = run('json-retry.jsonl');
    expect(state.turnEndKind).toBe('completed');
    expect(state.finalText).toBe('done');
    expect(state.errorMessage).toBeUndefined();
    expect(state.usage).toMatchObject({ inputTokens: 14, outputTokens: 3 });
    expect(emitted.at(-1)).toEqual({ type: 'final', text: 'done' });
    expect(emitted.find((event) => event.type === 'error')).toMatchObject({
      message: '429 rate limited',
    });
  });

  it('keeps the final error when the retry gives up', () => {
    const { state, emitted } = run('json-retry-failed.jsonl');
    expect(state.turnEndKind).toBe('error');
    expect(state.finalText).toBeUndefined();
    expect(state.errorMessage).toBe('boom');
    expect(emitted.some((event) => event.type === 'final')).toBe(false);
    expect(emitted.some((event) => event.type === 'error')).toBe(true);
  });

  it('keeps partial text when the model stops at the output limit', () => {
    const { state, emitted } = run('json-length.jsonl');
    expect(state.turnEndKind).toBe('length');
    expect(state.finalText).toBe('partial');
    expect(emitted.at(-1)).toEqual({ type: 'final', text: 'partial' });
  });

  it('handles a final line split across chunks', () => {
    const text = readFileSync('test/fixtures/pi/json-basic.jsonl', 'utf8');
    const cut = text.indexOf('agent_settled');
    const fold = new PiFold();
    fold.push(Buffer.from(text.slice(0, cut)));
    fold.push(Buffer.from(text.slice(cut)));
    const state = fold.end();
    expect(state.finalText).toBe('hi');
    expect(state.turnEndKind).toBe('completed');
  });

  it('counts malformed lines without throwing', () => {
    const fold = new PiFold();
    fold.push(Buffer.from('{"type":"session","id":"s"}\nnot json\n'));
    const state = fold.end();
    expect(state.sessionId).toBe('s');
    expect(state.malformedLines).toBe(1);
  });
});
