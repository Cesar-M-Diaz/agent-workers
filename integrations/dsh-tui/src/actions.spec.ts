import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionConfirmation,
  type ActionDecision,
  CONFIRM_TIMEOUT_MS,
  describePending,
} from './actions.js';

function armed(decision: ActionDecision): Extract<ActionDecision, { kind: 'armed' }> {
  assert.equal(decision.kind, 'armed');
  return decision as Extract<ActionDecision, { kind: 'armed' }>;
}

test('first press arms, matching second press within five seconds executes', () => {
  let now = 1000;
  const machine = new ActionConfirmation(CONFIRM_TIMEOUT_MS, () => now);

  const first = armed(machine.press('j_1', 'cleanup'));
  assert.equal(first.pending.stage, 'confirm');
  assert.equal(describePending(first.pending), 'confirm cleanup?');

  now += 4000;
  const second = machine.press('j_1', 'cleanup');
  assert.deepEqual(second, {
    kind: 'execute',
    jobId: 'j_1',
    action: 'cleanup',
    stage: 'confirm',
    discard: false,
  });
  assert.equal(machine.getPending(), undefined);
});

test('a different key disarms without arming the new action', () => {
  const now = 0;
  const machine = new ActionConfirmation(CONFIRM_TIMEOUT_MS, () => now);
  armed(machine.press('j_1', 'cancel'));

  const other = machine.press('j_1', 'delete');
  assert.equal(other.kind, 'disarmed');
  assert.equal(machine.getPending(), undefined);

  const again = armed(machine.press('j_1', 'delete'));
  assert.equal(again.pending.action, 'delete');
});

test('timeout disarms and the next press arms a fresh window', () => {
  let now = 0;
  const machine = new ActionConfirmation(CONFIRM_TIMEOUT_MS, () => now);
  armed(machine.press('j_1', 'delete'));

  now = CONFIRM_TIMEOUT_MS + 1;
  assert.equal(machine.getPending(), undefined);
  const next = armed(machine.press('j_1', 'delete'));
  assert.equal(next.pending.expiresAtMs, now + CONFIRM_TIMEOUT_MS);
});

test('an explicit disarm clears the pending action', () => {
  const machine = new ActionConfirmation();
  armed(machine.press('j_1', 'cancel'));
  assert.equal(machine.disarm()?.action, 'cancel');
  assert.equal(machine.getPending(), undefined);
});

test('discard requires another two-press confirmation and executes with discard=true', () => {
  let now = 0;
  const machine = new ActionConfirmation(CONFIRM_TIMEOUT_MS, () => now);
  armed(machine.press('j_1', 'cleanup', 'discard'));

  now += 1000;
  const execute = machine.press('j_1', 'cleanup', 'discard');
  assert.deepEqual(execute, {
    kind: 'execute',
    jobId: 'j_1',
    action: 'cleanup',
    stage: 'discard',
    discard: true,
  });
});
