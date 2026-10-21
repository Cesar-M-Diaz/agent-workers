import assert from 'node:assert/strict';
import test from 'node:test';
import { displayWidth } from './sanitize.js';
import { MAX_STEER_CHARS, SteerEditor } from './steer-editor.js';

test('inserts text and newlines at the cursor and joins/splits lines', () => {
  const editor = new SteerEditor('abc\ndef');
  assert.equal(editor.text, 'abc\ndef');
  assert.equal(editor.rowIndex, 1);
  assert.equal(editor.columnIndex, 3);

  editor.up();
  assert.equal(editor.rowIndex, 0);
  editor.left();
  assert.equal(editor.insert('XY'), true);
  assert.equal(editor.text, 'abXYc\ndef');
  assert.equal(editor.columnIndex, 4);

  assert.equal(editor.newline(), true);
  assert.equal(editor.text, 'abXY\nc\ndef');
  assert.equal(editor.rowIndex, 1);
  assert.equal(editor.columnIndex, 0);
});

test('backspace and delete handle within-line and line-boundary edits', () => {
  const editor = new SteerEditor('ab\ncd');
  editor.backspace();
  assert.equal(editor.text, 'ab\nc');

  editor.home();
  editor.backspace();
  assert.equal(editor.text, 'abc');
  assert.equal(editor.rowIndex, 0);
  assert.equal(editor.columnIndex, 2);

  editor.home();
  editor.delete();
  assert.equal(editor.text, 'bc');
  editor.end();
  editor.delete();
  assert.equal(editor.text, 'bc');
});

test('arrow, home and end movement crosses lines and clamps to line length', () => {
  const editor = new SteerEditor('abc\nde\nfghi');
  assert.equal(editor.rowIndex, 2);
  assert.equal(editor.end(), false);

  editor.up();
  assert.equal(editor.rowIndex, 1);
  assert.equal(editor.columnIndex, 2);
  editor.up();
  assert.equal(editor.rowIndex, 0);
  assert.equal(editor.columnIndex, 2);

  editor.home();
  assert.equal(editor.columnIndex, 0);
  editor.left();
  assert.equal(editor.rowIndex, 0);
  editor.down();
  assert.equal(editor.rowIndex, 1);
  assert.equal(editor.columnIndex, 0);
  editor.right();
  assert.equal(editor.columnIndex, 1);
  editor.end();
  editor.right();
  assert.equal(editor.rowIndex, 2);
  assert.equal(editor.columnIndex, 0);
});

test('refuses input beyond the 20 000 character hard limit', () => {
  const editor = new SteerEditor('a'.repeat(MAX_STEER_CHARS - 1));
  assert.equal(editor.length, MAX_STEER_CHARS - 1);
  assert.equal(editor.atLimit, false);

  assert.equal(editor.insert('bc'), false);
  assert.equal(editor.length, MAX_STEER_CHARS - 1);

  assert.equal(editor.insert('b'), true);
  assert.equal(editor.length, MAX_STEER_CHARS);
  assert.equal(editor.atLimit, true);

  assert.equal(editor.newline(), false);
  assert.equal(editor.text.length, MAX_STEER_CHARS);
});

test('renders a height-limited window that follows the cursor row', () => {
  const editor = new SteerEditor('line1\nline2\nline3\nline4\nline5');
  const window = editor.renderWindow(20, 3);
  assert.deepEqual(window.lines, ['line3', 'line4', 'line5']);
  assert.equal(window.top, 2);
  assert.equal(window.cursorRow, 2);
  assert.equal(window.cursorCol, 5);
  assert.equal(window.cursorIndex, 5);
  assert.equal(window.totalLines, 5);
});

test('renders a width-limited window that follows the cursor column', () => {
  const editor = new SteerEditor('abcdefghijklmnop');
  const window = editor.renderWindow(10, 4);
  assert.deepEqual(window.lines, ['hijklmnop']);
  assert.equal(window.left, 7);
  assert.equal(window.cursorRow, 0);
  assert.equal(window.cursorCol, 9);
  assert.equal(window.cursorIndex, 9);
  for (const line of window.lines) assert.ok(displayWidth(line) <= 10);

  editor.home();
  const start = editor.renderWindow(10, 4);
  assert.deepEqual(start.lines, ['abcdefghij']);
  assert.equal(start.left, 0);
  assert.equal(start.cursorIndex, 0);
});

test('pasted CRLF and terminal control bytes never reach the buffer', () => {
  const editor = new SteerEditor('');
  assert.equal(editor.insert('one\r\ntwo\u001b[31m\u0007'), true);
  assert.equal(editor.text, 'one\ntwo ');
  assert.equal(editor.lineCount, 2);
});

test('window clipping never splits wide characters', () => {
  const editor = new SteerEditor('a漢b漢c漢d漢e');
  const window = editor.renderWindow(5, 2);
  assert.ok(window.lines.length > 0);
  for (const line of window.lines) assert.ok(displayWidth(line) <= 5);
  assert.equal(window.cursorRow, 0);
  assert.ok(window.cursorIndex <= (window.lines[0]?.length ?? 0));
});
