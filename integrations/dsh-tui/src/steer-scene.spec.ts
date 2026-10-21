import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STEER_ACTIVE_WARNING,
  SteerSubmitGate,
  steerStatusLine,
  steerWarningLines,
} from './steer-scene.js';

test('a first Ctrl+S arms and a second within five seconds submits', () => {
  let now = 1000;
  const gate = new SteerSubmitGate(5000, () => now);
  assert.equal(gate.press(), 'armed');
  assert.equal(gate.isArmed(), true);

  now += 4999;
  assert.equal(gate.press(), 'submit');
  assert.equal(gate.isArmed(), false);
});

test('the submit confirmation expires and any other key disarms it', () => {
  let now = 0;
  const gate = new SteerSubmitGate(5000, () => now);
  assert.equal(gate.press(), 'armed');

  now = 5001;
  assert.equal(gate.isArmed(), false);
  assert.equal(gate.press(), 'armed');

  gate.disarm();
  assert.equal(gate.isArmed(), false);
  assert.equal(gate.press(), 'armed');
});

test('warning and status lines expose the cancel-first semantics and count', () => {
  assert.deepEqual(steerWarningLines(false), []);
  assert.deepEqual(steerWarningLines(true), [...STEER_ACTIVE_WARNING]);
  assert.match(STEER_ACTIVE_WARNING.join(' '), /cancels this running job first/);
  assert.match(STEER_ACTIVE_WARNING.join(' '), /if resuming fails it stays cancelled/);
  assert.equal(steerStatusLine(0), '0/20000');
  assert.equal(steerStatusLine(12, 'sending…'), '12/20000 · sending…');
});
