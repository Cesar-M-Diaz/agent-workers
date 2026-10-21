import assert from 'node:assert/strict';
import test from 'node:test';
import { displayWidth, fitText, sanitizeText, stripControl, truncateCells } from './sanitize.js';

test('strips CSI, OSC and C0/C1 control characters', () => {
  assert.equal(stripControl('a\u001b[31mred\u001b[0mb'), 'aredb');
  assert.equal(stripControl('x\u001b]0;pwned\u0007y'), 'xy');
  assert.equal(stripControl('\u009b31mred\u009b0m'), 'red');
  assert.equal(stripControl('a\u009d0;pwned\u009cb'), 'ab');
  assert.equal(stripControl('\u0001a\u0002b\u007fc\u009fd'), ' a b c d');
  assert.equal(sanitizeText('\u0001a\u0002b\u007fc\u009fd'), 'a b c d');
});

test('sanitizes labels, keeps no control characters and collapses whitespace', () => {
  assert.equal(sanitizeText('  evil \u001b[31mred\u001b[0m label\u0007 '), 'evil red label');
  assert.equal(
    sanitizeText('warn: retrying\n\u001b[2Jcleared screen\n'),
    'warn: retrying cleared screen',
  );
  assert.equal(sanitizeText('a\t\tb   c'), 'a b c');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(42), '');
  assert.doesNotMatch(sanitizeText('\u009b31mred\u009b0m'), /[\u0000-\u001f\u007f-\u009f]/);
});

test('truncates to terminal cells with an ellipsis', () => {
  assert.equal(truncateCells('abcdef', 4), 'abc…');
  assert.equal(truncateCells('abc', 4), 'abc');
  assert.equal(truncateCells('abc', 0), '');
  assert.equal(displayWidth(truncateCells('abcdef', 4)), 4);
});

test('accounts for wide and combining characters', () => {
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(truncateCells('你好世界', 5), '你好…');
  assert.equal(displayWidth(truncateCells('你好世界', 5)), 5);
  assert.equal(fitText('😀😀😀', 4), '😀…');
});

test('fitText always returns a sanitized line within the width', () => {
  const raw = '  \u001b[31mhello\u001b[0m\nworld  ';
  const fitted = fitText(raw, 8);
  assert.equal(fitted, 'hello w…');
  assert.equal(displayWidth(fitted), 8);
  for (const width of [1, 2, 3, 7, 8, 28, 40, 64]) {
    assert.ok(displayWidth(fitText(raw, width)) <= width);
    assert.doesNotMatch(fitText(raw, width), /[\u0000-\u001f\u007f-\u009f]/);
  }
});
