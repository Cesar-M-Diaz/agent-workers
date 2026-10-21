import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CONTROL_PROTOCOL, ControlClient } from './control-client.js';
import { WorkersStore } from './store.js';

interface Recorded {
  method: string;
  url: string;
  body: string;
}

interface FakeServer {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function startFakeServer(
  onRequest: (recorded: Recorded, res: ServerResponse) => void,
): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const requests: Recorded[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: Recorded = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(recorded);
        onRequest(recorded, res);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function tempState(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-store-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'jobs'), { recursive: true, mode: 0o700 });
  return root;
}

async function writeJob(root: string, id: string, ownerId: string): Promise<void> {
  const dir = join(root, 'jobs', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, 'job.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      label: id,
      backend: 'dsh',
      ownerId,
      status: 'succeeded',
      createdAt: '2026-10-21T09:00:00.000Z',
      finishedAt: '2026-10-21T09:01:00.000Z',
      steps: 1,
      toolCalls: 0,
      eventsCount: 0,
      malformedLines: 0,
      alerts: [],
      worktree: { path: `/tmp/${id}`, branch: 'b', repoRoot: '/tmp/repo', cleaned: false },
    }),
    { mode: 0o600 },
  );
}

async function writeOwner(root: string, ownerId: string, baseUrl: string): Promise<void> {
  await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 });
  const path = join(root, 'control', `${ownerId}.json`);
  await writeFile(
    path,
    JSON.stringify({
      protocol: CONTROL_PROTOCOL,
      owner_id: ownerId,
      pid: process.pid,
      started_at: '2026-10-21T09:00:00.000Z',
      version: '0.5.0',
      state_dir: root,
      control: {
        base_url: baseUrl,
        port: Number(new URL(baseUrl).port),
        token: 'tok-store',
      },
      ready: true,
    }),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}

function jobView(id: string, ownerId: string, capabilities: Record<string, boolean>): unknown {
  return {
    job_id: id,
    label: id,
    status: 'succeeded',
    owner_id: ownerId,
    capabilities: {
      cancel: false,
      steer: false,
      cleanup: true,
      delete: true,
      read_result: true,
      read_events: true,
      ...capabilities,
    },
  };
}

test('an action for a job whose owner is not live is rejected without any HTTP call', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_dead', 'owner-dead');

  let httpCalls = 0;
  const server = await startFakeServer((_requested, res) => {
    httpCalls += 1;
    sendJson(res, 200, { ok: true });
  });
  t.after(async () => server.close());

  const store = new WorkersStore(root, { pollMs: 60_000, idleMs: 60_000 });
  t.after(() => store.dispose());
  await store.refresh();
  await store.refreshControl(true);

  assert.equal(store.getSnapshot().control, 'offline');
  await store.requestAction('j_dead', 'cancel');
  assert.equal(httpCalls, 0);
  assert.match(store.getSnapshot().notice?.text ?? '', /control offline/);
});

test('routes cleanup to the read-model owner and drives the discard confirmation', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_live', 'owner-live');

  const discardBodies: boolean[] = [];
  const server = await startFakeServer((recorded, res) => {
    const url = new URL(recorded.url, 'http://127.0.0.1');
    if (recorded.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { ok: true, ready: true });
      return;
    }
    if (recorded.method === 'GET' && url.pathname === '/v1/jobs') {
      sendJson(res, 200, {
        server: { ok: true },
        jobs: [jobView('j_live', 'owner-live', { cleanup: true, delete: true })],
      });
      return;
    }
    if (recorded.method === 'POST' && url.pathname === '/v1/jobs/j_live/cleanup') {
      const body = JSON.parse(recorded.body || '{}') as { discard_changes?: boolean };
      discardBodies.push(body.discard_changes === true);
      sendJson(res, 200, {
        job_id: 'j_live',
        worktree: body.discard_changes === true ? 'removed' : 'preserved_dirty',
        branch_deleted: body.discard_changes === true,
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found', message: 'unknown route' });
  });
  t.after(async () => server.close());
  await writeOwner(root, 'owner-live', server.baseUrl);

  const client = new ControlClient(root);
  const store = new WorkersStore(root, { pollMs: 60_000, idleMs: 60_000, controlClient: client });
  t.after(() => store.dispose());
  await store.refresh();
  await store.refreshControl(true);

  assert.deepEqual(store.getSnapshot().control, { owners: 1 });
  assert.equal(store.getSnapshot().jobControls.get('j_live')?.ownerId, 'owner-live');

  await store.pressAction('j_live', 'cleanup');
  assert.equal(store.getSnapshot().pending?.stage, 'confirm');
  assert.equal(discardBodies.length, 0);

  await store.pressAction('j_live', 'cleanup');
  assert.deepEqual(discardBodies, [false]);
  assert.equal(store.getSnapshot().needsDiscard.get('j_live'), 'cleanup');
  assert.match(store.getSnapshot().notice?.text ?? '', /discard & cleanup\?/);

  await store.pressAction('j_live', 'cleanup');
  assert.equal(store.getSnapshot().pending?.stage, 'discard');
  assert.deepEqual(discardBodies, [false]);

  await store.pressAction('j_live', 'cleanup');
  assert.deepEqual(discardBodies, [false, true]);
  assert.equal(store.getSnapshot().needsDiscard.has('j_live'), false);
  assert.match(store.getSnapshot().notice?.text ?? '', /worktree removed/);
});

test('enforces one action in flight per job', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_live', 'owner-live');

  let cancels = 0;
  const server = await startFakeServer((recorded, res) => {
    const url = new URL(recorded.url, 'http://127.0.0.1');
    if (recorded.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (recorded.method === 'GET' && url.pathname === '/v1/jobs') {
      sendJson(res, 200, {
        server: { ok: true },
        jobs: [jobView('j_live', 'owner-live', { cancel: true })],
      });
      return;
    }
    if (recorded.method === 'POST' && url.pathname === '/v1/jobs/j_live/cancel') {
      cancels += 1;
      setTimeout(() => {
        sendJson(res, 200, {
          job_id: 'j_live',
          status: 'cancelled',
          killed_pids: [],
          survivors: [],
        });
      }, 40);
      return;
    }
    sendJson(res, 404, { error: 'not_found', message: 'unknown route' });
  });
  t.after(async () => server.close());
  await writeOwner(root, 'owner-live', server.baseUrl);

  const store = new WorkersStore(root, { pollMs: 60_000, idleMs: 60_000 });
  t.after(() => store.dispose());
  await store.refresh();
  await store.refreshControl(true);

  await Promise.all([
    store.requestAction('j_live', 'cancel'),
    store.requestAction('j_live', 'cancel'),
  ]);
  assert.equal(cancels, 1);
  assert.equal(store.getSnapshot().busy.has('j_live'), false);
});
