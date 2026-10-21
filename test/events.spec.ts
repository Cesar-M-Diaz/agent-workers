import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEventPage } from '../src/events.js';

describe('readEventPage', () => {
  let root: string;
  let eventsPath: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-events-test-'));
    eventsPath = join(root, 'events.ndjson');
    await writeFile(
      eventsPath,
      [
        JSON.stringify({ type: 'session', sessionId: 's1' }),
        JSON.stringify({ type: 'status', phase: 'step_start', step: 1 }),
        JSON.stringify({ type: 'tool_call', tool: 'bash' }),
        '{bad json',
        JSON.stringify({ type: 'final', text: 'x'.repeat(20_000) }),
      ].join('\n'),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns cursor-stable pages', async () => {
    const first = await readEventPage(eventsPath, 0, 2);
    expect(first.events.map((event) => event.type)).toEqual(['session', 'status']);
    expect(first.next_cursor).toBe(2);
    expect(first.total_events).toBe(5);
    expect(first.has_more).toBe(true);

    const second = await readEventPage(eventsPath, first.next_cursor, 2);
    expect(second.events.map((event) => event.type)).toEqual(['tool_call', 'malformed']);
    expect(second.next_cursor).toBe(4);
    expect(second.has_more).toBe(true);
  });

  it('marks malformed and oversized events without returning giant payloads', async () => {
    const page = await readEventPage(eventsPath, 3, 2);
    expect(page.events[0]?.parse_error).toBe('invalid_json');
    expect(page.events[1]?.type).toBe('final');
    expect(page.events[1]?.truncated).toBe(true);
    expect(page.events[1]?.event).toBeUndefined();
    expect(page.events[1]?.preview?.length).toBeLessThanOrEqual(8_000);
  });

  it('returns an empty page for a missing file', async () => {
    const page = await readEventPage(join(root, 'missing.ndjson'));
    expect(page).toEqual({ events: [], next_cursor: 0, total_events: 0, has_more: false });
  });
});
