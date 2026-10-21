import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActionKind, PendingAction } from './actions.js';
import type { JobCapabilities } from './control-client.js';
import { buildModel, type JobControlView, type ModelControl } from './model.js';
import { displayWidth } from './sanitize.js';
import { StateReader, type WorkerJob } from './state-reader.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/state', import.meta.url));
const NOW = Date.parse('2026-10-21T09:10:00.000Z');

function capabilities(overrides: Partial<JobCapabilities> = {}): JobCapabilities {
  return {
    cancel: false,
    steer: false,
    cleanup: false,
    delete: false,
    read_result: true,
    read_events: true,
    ...overrides,
  };
}

function controlFor(
  jobId: string,
  caps: JobCapabilities,
  extra: Partial<ModelControl> = {},
): ModelControl {
  const jobs = new Map<string, JobControlView>([
    [jobId, { ownerId: 'owner-live', capabilities: caps }],
  ]);
  return { state: { owners: 1 }, jobs, ...extra };
}

function rendered(model: ReturnType<typeof buildModel>): string[] {
  const lines = [...model.header, model.banner, model.footer];
  if (model.error !== undefined) lines.push(model.error);
  for (const group of model.groups) {
    lines.push(`▸ ${group.name} · ${group.rows.length}`);
    for (const row of group.rows) lines.push(...row.lines);
  }
  if (model.detail !== undefined) lines.push(...model.detail.lines);
  return lines;
}

async function selected(): Promise<WorkerJob[]> {
  return (await new StateReader(FIXTURE).read({ selectedId: 'j_000000000001' })).jobs;
}

test('control online/offline header and footer fit 28, 40 and 64 columns', async () => {
  const jobs = await selected();
  const online = controlFor('j_000000000001', capabilities({ cancel: true }));
  const offline: ModelControl = { state: 'offline' };
  const pending: PendingAction = {
    jobId: 'j_000000000001',
    action: 'delete',
    stage: 'confirm',
    expiresAtMs: NOW + 5000,
  };

  for (const width of [28, 40, 64]) {
    const models = [
      buildModel(jobs, {
        width,
        selectedId: 'j_000000000001',
        showAll: true,
        now: NOW,
        control: online,
      }),
      buildModel(jobs, {
        width,
        selectedId: 'j_000000000001',
        showAll: true,
        now: NOW,
        control: offline,
      }),
      buildModel(jobs, {
        width,
        selectedId: 'j_000000000001',
        showAll: true,
        now: NOW,
        control: controlFor('j_000000000001', capabilities({ delete: true }), { pending }),
      }),
    ];
    for (const model of models) {
      for (const line of rendered(model)) {
        assert.ok(
          displayWidth(line) <= width,
          `${width}: ${JSON.stringify(line)} is ${displayWidth(line)} cells`,
        );
        assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
      }
    }
  }
});

test('shows the control banner line and available actions from capabilities', async () => {
  const jobs = await selected();
  const online = buildModel(jobs, {
    width: 64,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
    control: controlFor('j_000000000001', capabilities({ cancel: true, cleanup: true })),
  });
  assert.ok(online.header.includes('control: 1 owner'));
  assert.equal(online.control, 'control: 1 owner');
  assert.equal(online.banner, 'all groups');
  assert.ok(online.detail?.lines.includes('cancel ✓ · steer unavailable'));
  assert.ok(online.detail?.lines.includes('cleanup ✓ · delete ✗'));
  assert.equal(online.footer, '↑↓ enter r a · c x d');

  const offline = buildModel(jobs, {
    width: 64,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
    control: { state: 'offline' },
  });
  assert.ok(offline.header.includes('control offline — read-only'));
  assert.equal(offline.control, 'control offline — read-only');
});

test('footer shows armed confirmations, discard offers and the last result', async () => {
  const jobs = await selected();
  const pending: PendingAction = {
    jobId: 'j_000000000001',
    action: 'delete',
    stage: 'confirm',
    expiresAtMs: NOW + 5000,
  };
  const confirm = buildModel(jobs, {
    width: 40,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
    control: controlFor('j_000000000001', capabilities({ delete: true }), { pending }),
  });
  assert.equal(confirm.footer, 'confirm delete?');

  const discardOffers = new Map<string, ActionKind>([['j_000000000001', 'cleanup']]);
  const discard = buildModel(jobs, {
    width: 40,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
    control: controlFor('j_000000000001', capabilities({ cleanup: true }), {
      needsDiscard: discardOffers,
    }),
  });
  assert.equal(discard.footer, 'discard & cleanup?');
  assert.ok(discard.detail?.lines.includes('discard & cleanup?'));

  const result = buildModel(jobs, {
    width: 40,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
    control: controlFor('j_000000000001', capabilities(), {
      message: 'cleanup · worktree removed',
    }),
  });
  assert.equal(result.footer, 'cleanup · worktree removed');
});

test('per-job action errors are sanitized and shown in the detail view', async () => {
  const jobs = await selected();
  const errors = new Map<string, string>([['j_000000000001', 'unauthorized: bad\u001b[31m token']]);
  const model = buildModel(jobs, {
    width: 64,
    selectedId: 'j_000000000001',
    showAll: true,
    now: NOW,
    control: controlFor('j_000000000001', capabilities(), { errors }),
  });
  assert.ok(model.detail?.lines.includes('action error unauthorized: bad token'));
  for (const line of model.detail?.lines ?? []) {
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
  }
});
