import { readFile } from 'node:fs/promises';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_RETURNED_EVENT_CHARS = 12_000;
const MAX_PREVIEW_CHARS = 8_000;

export interface WorkerEvent {
  cursor: number;
  type: string;
  bytes: number;
  event?: Record<string, unknown>;
  truncated?: boolean;
  preview?: string;
  parse_error?: string;
}

export interface EventPage {
  events: WorkerEvent[];
  next_cursor: number;
  total_events: number;
  has_more: boolean;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

function parseEvent(line: string, cursor: number): WorkerEvent {
  const bytes = Buffer.byteLength(line, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      cursor,
      type: 'malformed',
      bytes,
      preview: line.slice(0, MAX_PREVIEW_CHARS),
      parse_error: 'invalid_json',
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      cursor,
      type: 'malformed',
      bytes,
      preview: line.slice(0, MAX_PREVIEW_CHARS),
      parse_error: 'not_an_object',
    };
  }

  const event = parsed as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const serialized = JSON.stringify(event);
  if (serialized.length > MAX_RETURNED_EVENT_CHARS) {
    return {
      cursor,
      type,
      bytes,
      truncated: true,
      preview: serialized.slice(0, MAX_PREVIEW_CHARS),
    };
  }
  return { cursor, type, bytes, event };
}

/**
 * Read one stable, cursor-based page from a DSH `--json` NDJSON event file.
 * A cursor is a zero-based event line index; `next_cursor` can be passed back
 * unchanged on the next call. The file may be appended to between calls.
 */
export async function readEventPage(
  eventsPath: string,
  cursor = 0,
  limit?: number,
): Promise<EventPage> {
  let text: string;
  try {
    text = await readFile(eventsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], next_cursor: 0, total_events: 0, has_more: false };
    }
    throw err;
  }

  const lines = text.split('\n').filter((line) => line.length > 0);
  const totalEvents = lines.length;
  const start = Math.max(0, Math.min(totalEvents, Math.trunc(cursor)));
  const count = clampLimit(limit);
  const events = lines
    .slice(start, start + count)
    .map((line, index) => parseEvent(line, start + index));
  const nextCursor = start + events.length;
  return {
    events,
    next_cursor: nextCursor,
    total_events: totalEvents,
    has_more: nextCursor < totalEvents,
  };
}
