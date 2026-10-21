/**
 * Pure multiline text buffer for the steer scene.
 *
 * The buffer has no React, filesystem or network dependency: the scene mutates
 * it from key events and renders a width/height window that keeps the cursor
 * visible. Length is measured in JavaScript string units, exactly like the
 * control API's `message.length` check, so the 20 000 limit matches the server.
 */

import { displayWidth, stripControl } from './sanitize.js';

export const MAX_STEER_CHARS = 20_000;

export interface SteerWindow {
  /** Visible text lines, clipped to `width` cells and `height` rows. */
  readonly lines: string[];
  /** First source line represented by `lines`. */
  readonly top: number;
  /** First source cell represented by every line (horizontal scroll). */
  readonly left: number;
  /** Cursor row relative to the window (0-based). */
  readonly cursorRow: number;
  /** Cursor display cell relative to the window (0-based). */
  readonly cursorCol: number;
  /** Cursor index inside `lines[cursorRow]`, suitable for slicing. */
  readonly cursorIndex: number;
  readonly width: number;
  readonly height: number;
  readonly totalLines: number;
  readonly length: number;
  readonly atLimit: boolean;
}

/** Preserve newlines but make pasted control bytes/escapes harmless. */
function normalizeInput(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => stripControl(line))
    .join('\n');
}

/** Index of the code point before `index` (never splits a surrogate pair). */
function previousIndex(line: string, index: number): number {
  if (index <= 0) return 0;
  const low = line.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = line.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return index - 2;
  }
  return index - 1;
}

/** Index after the code point at `index` (never splits a surrogate pair). */
function nextIndex(line: string, index: number): number {
  if (index >= line.length) return line.length;
  const high = line.charCodeAt(index);
  if (high >= 0xd800 && high <= 0xdbff && index + 1 < line.length) {
    const low = line.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return index + 2;
  }
  return index + 1;
}

interface Clip {
  readonly text: string;
  readonly index: number;
  readonly cell: number;
}

/**
 * Clip `line` to the `width` cells starting at `left`. `cursor` is a cell
 * offset; `index` is the matching cursor index inside `text` (or -1).
 */
function clipLine(line: string, left: number, width: number, cursor?: number): Clip {
  let cell = 0;
  let text = '';
  let index = -1;
  let used = 0;
  for (const char of line) {
    const charWidth = displayWidth(char);
    const start = cell;
    cell += charWidth;
    if (start < left) continue;
    if (start + charWidth > left + width) break;
    if (cursor !== undefined && index < 0 && start >= cursor) index = text.length;
    text += char;
    used += charWidth;
  }
  if (cursor !== undefined && index < 0) index = text.length;
  return { text, index, cell: used };
}

export class SteerEditor {
  private lines: string[];
  private row = 0;
  private col = 0;

  constructor(initial = '') {
    const text = normalizeInput(initial);
    this.lines = text.split('\n');
    if (text.length > MAX_STEER_CHARS) {
      // Defensive: callers only pass user text that already respects the limit.
      this.lines = [text.slice(0, MAX_STEER_CHARS)];
    }
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]?.length ?? 0;
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get length(): number {
    return this.text.length;
  }

  get atLimit(): boolean {
    return this.length >= MAX_STEER_CHARS;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get rowIndex(): number {
    return this.row;
  }

  get columnIndex(): number {
    return this.col;
  }

  get currentLine(): string {
    return this.lines[this.row] ?? '';
  }

  /**
   * Insert text at the cursor. Returns false (and changes nothing) when the
   * chunk is empty after sanitization or would cross the hard limit.
   */
  insert(value: string): boolean {
    const text = normalizeInput(value);
    if (text === '') return false;
    if (this.length + text.length > MAX_STEER_CHARS) return false;

    const parts = text.split('\n');
    const current = this.currentLine;
    const before = current.slice(0, this.col);
    const after = current.slice(this.col);
    if (parts.length === 1) {
      this.lines[this.row] = `${before}${text}${after}`;
      this.col += text.length;
      return true;
    }
    const first = parts[0] ?? '';
    const last = parts.at(-1) ?? '';
    this.lines.splice(this.row, 1, `${before}${first}`, ...parts.slice(1, -1), `${last}${after}`);
    this.row += parts.length - 1;
    this.col = last.length;
    return true;
  }

  newline(): boolean {
    return this.insert('\n');
  }

  backspace(): boolean {
    if (this.col > 0) {
      const index = previousIndex(this.currentLine, this.col);
      this.lines[this.row] =
        `${this.currentLine.slice(0, index)}${this.currentLine.slice(this.col)}`;
      this.col = index;
      return true;
    }
    if (this.row === 0) return false;
    const previous = this.lines[this.row - 1] ?? '';
    const current = this.currentLine;
    this.lines.splice(this.row - 1, 2, `${previous}${current}`);
    this.row -= 1;
    this.col = previous.length;
    return true;
  }

  delete(): boolean {
    if (this.col < this.currentLine.length) {
      const index = nextIndex(this.currentLine, this.col);
      this.lines[this.row] =
        `${this.currentLine.slice(0, this.col)}${this.currentLine.slice(index)}`;
      return true;
    }
    if (this.row >= this.lines.length - 1) return false;
    this.lines.splice(this.row, 2, `${this.currentLine}${this.lines[this.row + 1] ?? ''}`);
    return true;
  }

  left(): boolean {
    if (this.col > 0) {
      this.col = previousIndex(this.currentLine, this.col);
      return true;
    }
    if (this.row === 0) return false;
    this.row -= 1;
    this.col = this.currentLine.length;
    return true;
  }

  right(): boolean {
    if (this.col < this.currentLine.length) {
      this.col = nextIndex(this.currentLine, this.col);
      return true;
    }
    if (this.row >= this.lines.length - 1) return false;
    this.row += 1;
    this.col = 0;
    return true;
  }

  up(): boolean {
    if (this.row === 0) return false;
    this.row -= 1;
    this.col = Math.min(this.col, this.currentLine.length);
    return true;
  }

  down(): boolean {
    if (this.row >= this.lines.length - 1) return false;
    this.row += 1;
    this.col = Math.min(this.col, this.currentLine.length);
    return true;
  }

  home(): boolean {
    if (this.col === 0) return false;
    this.col = 0;
    return true;
  }

  end(): boolean {
    if (this.col === this.currentLine.length) return false;
    this.col = this.currentLine.length;
    return true;
  }

  /**
   * Render a window that follows both the cursor row (vertical) and the
   * cursor cell (horizontal). Every returned line is at most `width` cells.
   */
  renderWindow(width: number, height: number): SteerWindow {
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const total = this.lines.length;
    const maxTop = Math.max(0, total - safeHeight);
    const top = Math.min(maxTop, Math.max(0, this.row - safeHeight + 1));

    const cursorCell = displayWidth(this.currentLine.slice(0, this.col));
    const left = cursorCell >= safeWidth ? cursorCell - safeWidth + 1 : 0;

    const lines: string[] = [];
    let cursorIndex = 0;
    let cursorCol = 0;
    for (let index = 0; index < safeHeight; index += 1) {
      const source = top + index;
      if (source >= total) break;
      const line = this.lines[source] ?? '';
      const isCursor = source === this.row;
      if (isCursor) {
        const clip = clipLine(line, left, safeWidth, cursorCell);
        lines.push(clip.text);
        cursorIndex = Math.max(0, clip.index);
        cursorCol = Math.max(0, cursorCell - left);
      } else {
        lines.push(clipLine(line, left, safeWidth).text);
      }
    }

    return {
      lines,
      top,
      left,
      cursorRow: this.row - top,
      cursorCol,
      cursorIndex,
      width: safeWidth,
      height: safeHeight,
      totalLines: total,
      length: this.length,
      atLimit: this.atLimit,
    };
  }

  /** Convenience view used by tests and non-cursor renderers. */
  render(width: number, height: number): string[] {
    return this.renderWindow(width, height).lines;
  }
}
