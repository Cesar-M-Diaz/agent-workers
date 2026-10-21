/**
 * Untrusted job data is rendered into a terminal, so every string must lose
 * ANSI escapes and control characters before it reaches a Text element.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI_OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Remove OSC/CSI sequences and replace remaining C0/C1 controls with spaces. */
export function stripControl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(CONTROL, ' ');
}

/** Strip escapes/controls, collapse whitespace and trim. */
export function sanitizeText(value: unknown): string {
  return stripControl(value).replace(/\s+/g, ' ').trim();
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200d ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** Approximate terminal cell width (wide CJK/emoji = 2, combining = 0). */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** Truncate to `maxCells` terminal cells, appending `…` when shortened. */
export function truncateCells(value: string, maxCells: number): string {
  if (maxCells <= 0) return '';
  const chars = Array.from(value);
  const widths = chars.map((char) => {
    const cp = char.codePointAt(0);
    if (cp === undefined || isZeroWidth(cp)) return 0;
    return isWide(cp) ? 2 : 1;
  });

  let used = 0;
  let end = 0;
  while (end < chars.length && used + (widths[end] ?? 0) <= maxCells) {
    used += widths[end] ?? 0;
    end += 1;
  }
  if (end === chars.length) return value;

  while (end > 0 && used + 1 > maxCells) {
    end -= 1;
    used -= widths[end] ?? 0;
  }
  return `${chars.slice(0, end).join('')}…`;
}

/** Sanitize and truncate in one step; the result never exceeds `maxCells`. */
export function fitText(value: unknown, maxCells: number): string {
  return truncateCells(sanitizeText(value), maxCells);
}
