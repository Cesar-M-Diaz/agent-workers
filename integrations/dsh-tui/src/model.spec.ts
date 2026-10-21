import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildModel, type WorkersModel } from './model.js';
import { displayWidth, fitText } from './sanitize.js';
import { StateReader, type WorkerJob } from './state-reader.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/state', import.meta.url));
const NOW = Date.parse('2026-10-21T09:10:00.000Z');
const IDS = [
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
];

function renderedLines(model: WorkersModel): string[] {
  const lines = [...model.header, model.banner];
  if (model.error !== undefined) lines.push(model.error);
  for (const group of model.groups) {
    lines.push(
      fitText(`${group.active ? '▾' : '▸'} ${group.name} · ${group.rows.length}`, model.width),
    );
    for (const row of group.rows) lines.push(...row.lines);
  }
  if (model.detail !== undefined) lines.push(...model.detail.lines);
  return lines;
}

function detailOf(model: WorkersModel): string[] {
  assert.ok(model.detail, 'expected a detail block');
  return model.detail.lines;
}

test('every fixture job fits 28, 40 and 64 columns', async () => {
  const reader = new StateReader(FIXTURE);
  for (const id of IDS) {
    const { jobs } = await reader.read({ selectedId: id });
    for (const width of [28, 40, 64]) {
      const model = buildModel(jobs, {
        width,
        selectedId: id,
        showAll: true,
        now: NOW,
      });
      assert.equal(model.empty, false);
      const lines = renderedLines(model);
      assert.ok(lines.length > 0);
      for (const line of lines) {
        assert.ok(
          displayWidth(line) <= width,
          `${id} at ${width}: ${JSON.stringify(line)} is ${displayWidth(line)} cells`,
        );
        assert.doesNotMatch(
          line,
          /[\u0000-\u001f\u007f-\u009f]/,
          `${id} at ${width}: ${JSON.stringify(line)}`,
        );
      }
      assert.ok(detailOf(model).length > 0);
    }
  }
});

test('header counts, total cost, grouping and active-first order', async () => {
  const reader = new StateReader(FIXTURE);
  const { jobs } = await reader.read();
  const model = buildModel(jobs, { width: 64, showAll: true, now: NOW });
  assert.equal(model.header[1], '3 run · 1 queued · 5 done');
  assert.equal(model.header[2], 'cost $0.0026 · 10 jobs');
  assert.equal(model.banner, 'read-only · all groups');
  assert.equal(model.groups.length, 3);
  const active = model.groups.filter((group) => group.active);
  assert.ok(active.length > 0);
  assert.equal(model.groups.at(-1)?.name, 'beta-project');
  const legacy = model.groups.find((group) => group.id === '__legacy__');
  assert.ok(legacy);
  assert.equal(legacy.name, 'Legacy / ungrouped');
  assert.equal(legacy.rows[0]?.id, 'j_000000000009');
});

test('detail shows the contract fields from the fixture', async () => {
  const reader = new StateReader(FIXTURE);
  const load = async (id: string): Promise<WorkerJob[]> =>
    (await reader.read({ selectedId: id })).jobs;

  const running = buildModel(await load('j_000000000001'), {
    width: 64,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
  });
  const runningLines = detailOf(running);
  assert.ok(runningLines.includes('status running'));
  assert.ok(runningLines.includes('backend dsh · profile personal-deepseek'));
  assert.ok(runningLines.includes('access workspace-write · isolation worktree'));
  assert.ok(runningLines.includes('text Running the tests now.'));
  assert.ok(runningLines.includes('read: src/auth.ts'));
  assert.ok(runningLines.includes('bash: pnpm test'));
  assert.ok(runningLines.some((line) => line.startsWith('alert stalled: no events for 2m')));
  assert.ok(runningLines.includes('usage in 1200 · out 300 · total 1500'));
  assert.ok(runningLines.includes('cost $0.0021'));

  const succeeded = buildModel(await load('j_000000000003'), {
    width: 64,
    selectedId: 'j_000000000003',
    showAll: true,
    now: NOW,
  });
  const succeededLines = detailOf(succeeded);
  assert.ok(succeededLines.includes('usage in 15 · out 5 · total 20'));
  assert.ok(succeededLines.includes('cost $0.0005'));
  assert.ok(succeededLines.includes('final'));
  assert.ok(succeededLines.some((line) => line.includes('Audit')));
  assert.ok(succeededLines.some((line) => line.includes('src/a.ts:10')));

  const failed = buildModel(await load('j_000000000004'), {
    width: 64,
    selectedId: 'j_000000000004',
    showAll: true,
    now: NOW,
  });
  const failedLines = detailOf(failed);
  assert.ok(failedLines.includes('label evil red label'));
  assert.ok(failedLines.includes('error provider error 429'));
  assert.ok(failedLines.includes('stderr'));
  assert.ok(failedLines.includes('· warn: retrying cleared screen'));
  assert.ok(
    failedLines.some((line) => line.startsWith('alert tool_errors: 5 tool errors in a row')),
  );
  assert.ok(
    failedLines.some((line) => line.startsWith('alert loop: same tool call repeated 4 times')),
  );

  const steered = buildModel(await load('j_000000000005'), {
    width: 64,
    selectedId: 'j_000000000005',
    showAll: true,
    now: NOW,
  });
  const steeredLines = detailOf(steered);
  assert.ok(steeredLines.includes('status cancelled · steered'));
  assert.ok(steeredLines.includes('busy worktree · session'));

  const resumed = buildModel(await load('j_000000000006'), {
    width: 64,
    selectedId: 'j_000000000006',
    showAll: true,
    now: NOW,
  });
  assert.ok(
    detailOf(resumed).some((line) =>
      line.includes('lineage resume j_000000000005 · steered j_000000000005'),
    ),
  );

  const cleaned = buildModel(await load('j_000000000007'), {
    width: 64,
    selectedId: 'j_000000000007',
    showAll: true,
    now: NOW,
  });
  assert.ok(
    detailOf(cleaned).some((line) => line.includes('worktree') && line.includes('cleaned')),
  );
  assert.ok(detailOf(cleaned).includes('cost n/a'));

  const legacy = buildModel(await load('j_000000000009'), {
    width: 64,
    selectedId: 'j_000000000009',
    showAll: true,
    now: NOW,
  });
  const legacyLines = detailOf(legacy);
  assert.ok(legacyLines.includes('backend dsh · profile personal-deepseek'));
  assert.ok(legacyLines.includes('cost n/a'));
  assert.ok(legacyLines.some((line) => line.includes('worktree') && line.includes('cleaned')));

  const unknown = buildModel(await load('j_00000000000b'), {
    width: 64,
    selectedId: 'j_00000000000b',
    showAll: true,
    now: NOW,
  });
  const unknownRow = unknown.rows.find((row) => row.id === 'j_00000000000b');
  assert.ok(unknownRow);
  assert.match(unknownRow.lines[0] ?? '', /unknown \(paused\)/);
  assert.ok(detailOf(unknown).includes('status unknown (paused)'));
});

test('current-project scope hides unrelated groups unless showAll is on', async () => {
  const reader = new StateReader(FIXTURE);
  const { jobs } = await reader.read();
  const scoped = buildModel(jobs, {
    width: 64,
    showAll: false,
    cwd: '/fixture/state/worktrees/j_000000000001',
    now: NOW,
  });
  assert.equal(scoped.banner, 'read-only · current project');
  assert.deepEqual(
    scoped.groups.map((group) => group.name),
    ['alpha-project'],
  );
  assert.deepEqual(
    scoped.rows.map((row) => row.id),
    [
      'j_000000000006',
      'j_000000000001',
      'j_000000000002',
      'j_000000000005',
      'j_000000000004',
      'j_000000000003',
      'j_00000000000b',
      'j_000000000007',
    ],
  );

  const all = buildModel(jobs, {
    width: 64,
    showAll: true,
    cwd: '/fixture/state/worktrees/j_000000000001',
    now: NOW,
  });
  assert.equal(all.banner, 'read-only · all groups');
  assert.equal(all.groups.length, 3);

  const unmatched = buildModel(jobs, {
    width: 64,
    showAll: false,
    cwd: '/fixture/nope',
    now: NOW,
  });
  assert.equal(unmatched.banner, 'read-only · all groups');
  assert.equal(unmatched.groups.length, 3);
});

test('selection markers and empty state are stable', async () => {
  const reader = new StateReader(FIXTURE);
  const { jobs } = await reader.read();
  const model = buildModel(jobs, {
    width: 28,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
  });
  const selected = model.rows.find((row) => row.id === 'j_000000000001');
  assert.ok(selected);
  assert.equal(selected.selected, true);
  assert.match(selected.lines[0] ?? '', /^▸/);

  const empty = buildModel([], { width: 28, now: NOW });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.header[1], '0 run · 0 queued · 0 done');
  assert.equal(empty.header[2], 'cost n/a · 0 jobs');
});
