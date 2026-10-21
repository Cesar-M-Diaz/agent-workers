import { describe, expect, it } from 'vitest';
import { NdjsonFold } from '../src/ndjson.js';

const event = (value: unknown) => `${JSON.stringify(value)}\n`;

describe('NdjsonFold', () => {
  it('folds a successful run', () => {
    const fold = new NdjsonFold();
    fold.push(
      Buffer.from(
        event({ type: 'session', sessionId: 'session-1', cwd: '/tmp' }) +
          event({ type: 'status', phase: 'turn_start', turn: 1 }) +
          event({ type: 'status', phase: 'step_start', turn: 1, step: 1 }) +
          event({ type: 'tool_call', tool: 'read', callId: 'c1' }) +
          event({
            type: 'status',
            phase: 'step_end',
            turn: 1,
            step: 1,
            usage: { inputTokens: 2, outputTokens: 3 },
          }) +
          event({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }) +
          event({ type: 'final', text: 'answer' }),
      ),
    );
    const state = fold.end();
    expect(state.sessionId).toBe('session-1');
    expect(state.finalText).toBe('answer');
    expect(state.turnEndKind).toBe('completed');
    expect(state.toolCalls).toBe(1);
    expect(state.steps).toBe(1);
    expect(state.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(state.malformedLines).toBe(0);
  });

  it('keeps a final line larger than 32 KiB', () => {
    const fold = new NdjsonFold();
    const text = 'x'.repeat(64 * 1024);
    fold.push(Buffer.from(event({ type: 'final', text })));
    expect(fold.end().finalText).toBe(text);
  });

  it('does not lose a final line split across chunks or reads EOF without newline', () => {
    const fold = new NdjsonFold();
    const line = JSON.stringify({ type: 'final', text: 'última' });
    fold.push(Buffer.from(line.slice(0, 7)));
    fold.push(Buffer.from(line.slice(7)));
    expect(fold.end().finalText).toBe('última');
  });

  it('counts malformed lines and keeps folding', () => {
    const fold = new NdjsonFold();
    fold.push(Buffer.from('not json\n'));
    fold.push(Buffer.from(`${JSON.stringify({ type: 'final', text: 'ok' })}\n`));
    const state = fold.end();
    expect(state.malformedLines).toBe(1);
    expect(state.finalText).toBe('ok');
  });

  it('records an in-turn failure without an error event', () => {
    const fold = new NdjsonFold();
    fold.push(
      Buffer.from(
        event({ type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } }) +
          event({ type: 'final', text: '' }),
      ),
    );
    const state = fold.end();
    expect(state.turnEndKind).toBe('aborted');
    expect(state.finalText).toBe('');
    expect(state.errorMessage).toBeUndefined();
  });
});
