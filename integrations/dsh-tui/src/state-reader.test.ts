import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEventSource, StateReader, type WorkerJob } from './state-reader.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/state', import.meta.url));

function byId(jobs: readonly WorkerJob[], id: string): WorkerJob {
  const job = jobs.find((candidate) => candidate.id === id);
  assert.ok(job, `expected job ${id}`);
  return job;
}

test('reads the shared fixture exactly as its README describes', async () => {
  const reader = new StateReader(FIXTURE);
  const { jobs } = await reader.read();
  assert.deepEqual(
    jobs.map((job) => job.id),
    [
      'j_000000000001',
      'j_000000000002',
      'j_000000000003',
      'j_000000000004',
      'j_000000000005',
      'j_000000000006',
      'j_000000000007',
      'j_000000000008',
      'j_000000000009',
      'j_00000000000b',
    ],
  );

  const running = byId(jobs, 'j_000000000001');
  assert.equal(running.status, 'running');
  assert.equal(running.backend, 'dsh');
  assert.equal(running.events.length, 8);
  assert.equal(running.events.at(-1)?.type, 'text');
  assert.equal(running.lastText, 'Running the tests now.');
  assert.equal(running.eventsMtimeMs !== undefined, true);
  assert.equal(running.finalText, undefined);
  assert.equal(running.worktreeBusy, false);
  assert.equal(running.sessionBusy, false);

  const queued = byId(jobs, 'j_000000000002');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.backend, 'pi');
  assert.deepEqual(queued.events, []);
  assert.equal(queued.finalText, undefined);

  const succeeded = byId(jobs, 'j_000000000003');
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.costUsd, 0.0005);
  assert.deepEqual(succeeded.usage, {
    inputTokens: 15,
    outputTokens: 5,
    totalTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // Terminal job not selected: neither events nor final are read.
  assert.deepEqual(succeeded.events, []);
  assert.equal(succeeded.finalText, undefined);

  const failed = byId(jobs, 'j_000000000004');
  assert.equal(failed.label, 'evil red label');
  assert.equal(failed.errorMessage, 'provider error 429');
  assert.equal(failed.stderrTail, 'warn: retrying cleared screen');
  assert.equal(failed.alerts.length, 2);
  assert.deepEqual(
    failed.alerts.map((alert) => alert.kind),
    ['tool_errors', 'loop'],
  );
  assert.doesNotMatch(
    [
      failed.label,
      failed.errorMessage,
      failed.stderrTail,
      ...failed.alerts.map((a) => a.message),
    ].join(' '),
    /[\u0000-\u001f\u007f-\u009f]/,
  );

  const steered = byId(jobs, 'j_000000000005');
  assert.equal(steered.status, 'cancelled');
  assert.equal(steered.reason, 'steered');
  assert.equal(steered.cleaned, false);
  assert.equal(steered.worktreeBusy, true);
  assert.equal(steered.sessionBusy, true);

  const resumed = byId(jobs, 'j_000000000006');
  assert.equal(resumed.resumeOf, 'j_000000000005');
  assert.equal(resumed.steeredFrom, 'j_000000000005');
  assert.equal(resumed.worktreeBusy, false);
  assert.equal(resumed.sessionBusy, false);

  const cleanedTopLevel = byId(jobs, 'j_000000000007');
  assert.equal(cleanedTopLevel.cleaned, true);
  assert.equal(cleanedTopLevel.finalText, undefined);

  const interrupted = byId(jobs, 'j_000000000008');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.groupId, 'g-beta');
  assert.equal(interrupted.groupName, 'beta-project');

  const legacy = byId(jobs, 'j_000000000009');
  assert.equal(legacy.backend, 'dsh');
  assert.equal(legacy.groupId, undefined);
  assert.equal(legacy.groupName, undefined);
  assert.equal(legacy.costUsd, undefined);
  assert.equal(legacy.cleaned, true);

  const unknown = byId(jobs, 'j_00000000000b');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.rawStatus, 'paused');
});

test('reads events and final.md only for active and selected jobs', async () => {
  const reader = new StateReader(FIXTURE);
  const selected = await reader.read({ selectedId: 'j_000000000003' });
  const succeeded = byId(selected.jobs, 'j_000000000003');
  assert.equal(succeeded.events.length, 7);
  assert.match(succeeded.finalText ?? '', /Audit/);
  assert.match(succeeded.finalText ?? '', /src\/a\.ts:10/);

  const topLevelCleaned = byId(selected.jobs, 'j_000000000007');
  assert.equal(topLevelCleaned.finalText, undefined);

  const unselected = await reader.read();
  assert.deepEqual(byId(unselected.jobs, 'j_000000000003').events, []);
  assert.equal(byId(unselected.jobs, 'j_000000000003').finalText, undefined);

  const done = await reader.read({ selectedId: 'j_000000000007' });
  assert.equal(byId(done.jobs, 'j_000000000007').finalText, 'done\n');

  const unknown = await reader.read({ selectedId: 'j_00000000000b' });
  assert.equal(byId(unknown.jobs, 'j_00000000000b').finalText, undefined);
});

test('keeps the last valid job.json after a successful read', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'agent-workers-torn-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  await cp(FIXTURE, temp, { recursive: true });

  const reader = new StateReader(temp);
  const first = await reader.read();
  const before = byId(first.jobs, 'j_000000000001');

  const jobPath = join(temp, 'jobs', 'j_000000000001', 'job.json');
  await writeFile(jobPath, '{"id":"j_000000000001","status":"runn');
  const second = await reader.read();
  const after = byId(second.jobs, 'j_000000000001');
  assert.equal(after.jobJsonInvalid, true);
  assert.equal(after.label, before.label);
  assert.equal(after.status, before.status);
  assert.equal(after.steps, before.steps);
  assert.equal(after.groupName, before.groupName);
});

test('parseEventSource skips malformed and trailing partial lines', () => {
  const source =
    '{"type":"text","text":"one"}\nnot json\n{"type":"text","text":"two"}\n{"type":"tool_call"';
  assert.deepEqual(
    parseEventSource(source).map((event) => event.text ?? event.type),
    ['one', 'two'],
  );

  const tail = 'ull,"text":"cut"}\n{"type":"text","text":"kept"}\n';
  assert.deepEqual(
    parseEventSource(tail, true).map((event) => event.text),
    ['kept'],
  );
  assert.deepEqual(
    parseEventSource('').map((event) => event.type),
    [],
  );
});
