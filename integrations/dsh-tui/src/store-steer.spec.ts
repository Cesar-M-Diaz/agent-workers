import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CONTROL_PROTOCOL, ControlClient, ControlRequestError } from './control-client.js';
import { buildModel } from './model.js';
import { WorkersStore } from './store.js';

interface Recorded {
  method: string;
  url: string;
  body: string;
  authorization?: string;
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
          authorization: req.headers.authorization,
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-steer-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'jobs'), { recursive: true, mode: 0o700 });
  return root;
}

async function writeJob(
  root: string,
  id: string,
  ownerId: string,
  status = 'succeeded',
): Promise<void> {
  const dir = join(root, 'jobs', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, 'job.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      label: `label ${id}`,
      backend: 'dsh',
      ownerId,
      status,
      createdAt: '2026-10-21T09:00:00.000Z',
      startedAt: '2026-10-21T09:00:00.000Z',
      finishedAt: status === 'running' ? undefined : '2026-10-21T09:01:00.000Z',
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
        token: 'tok-steer',
      },
      ready: true,
    }),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}

function jobView(
  id: string,
  ownerId: string,
  capabilities: Record<string, boolean>,
  status = 'succeeded',
): unknown {
  return {
    job_id: id,
    label: `label ${id}`,
    status,
    owner_id: ownerId,
    capabilities: {
      cancel: false,
      steer: true,
      cleanup: true,
      delete: true,
      read_result: true,
      read_events: true,
      ...capabilities,
    },
  };
}

test('requestSteer POSTs the message and returns steered_job_id on 200', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_live', 'owner-live');

  const steered: Recorded[] = [];
  const server = await startFakeServer((recorded, res) => {
    const url = new URL(recorded.url, 'http://127.0.0.1');
    if (recorded.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (recorded.method === 'GET' && url.pathname === '/v1/jobs') {
      sendJson(res, 200, { jobs: [jobView('j_live', 'owner-live', {})] });
      return;
    }
    if (recorded.method === 'POST' && url.pathname === '/v1/jobs/j_live/steer') {
      steered.push(recorded);
      sendJson(res, 200, {
        job_id: 'j_live',
        steered_job_id: 'j_new',
        cancelled: true,
        status: 'queued',
        label: 'label j_live (steer)',
        group_id: 'g',
        group_name: 'G',
        cwd: '/tmp',
        steered_from: 'j_live',
      });
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

  const outcome = await store.requestSteer('j_live', 'please focus on tests\nand docs');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.steered_job_id, 'j_new');
  assert.equal(outcome.result.cancelled, true);
  assert.equal(steered.length, 1);
  assert.equal(steered[0]?.authorization, 'Bearer tok-steer');
  assert.deepEqual(JSON.parse(steered[0]?.body ?? '{}'), {
    message: 'please focus on tests\nand docs',
  });
  assert.match(store.getSnapshot().notice?.text ?? '', /steer → j_new · queued/);
  assert.equal(store.getSnapshot().busy.has('j_live'), false);
});

test('requestSteer surfaces a 409 resume_unavailable as a typed error', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_live', 'owner-live', 'running');

  const server = await startFakeServer((recorded, res) => {
    const url = new URL(recorded.url, 'http://127.0.0.1');
    if (recorded.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (recorded.method === 'GET' && url.pathname === '/v1/jobs') {
      sendJson(res, 200, { jobs: [jobView('j_live', 'owner-live', {}, 'running')] });
      return;
    }
    if (recorded.method === 'POST' && url.pathname === '/v1/jobs/j_live/steer') {
      sendJson(res, 409, {
        error: 'resume_unavailable',
        message: 'the original job was cancelled before dsh emitted a session id',
      });
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

  const outcome = await store.requestSteer('j_live', 'keep going');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.error instanceof ControlRequestError);
  assert.equal(outcome.error.status, 409);
  assert.equal(outcome.error.code, 'resume_unavailable');
  assert.match(store.getSnapshot().actionErrors.get('j_live') ?? '', /resume_unavailable:/);
  assert.equal(store.getSnapshot().busy.has('j_live'), false);
});

test('requestSteer rejects a job with no live owner without any HTTP call', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_dead', 'owner-dead');

  let httpCalls = 0;
  const client = new ControlClient(root, {
    fetchImpl: (async () => {
      httpCalls += 1;
      throw new Error('must not be called');
    }) as typeof fetch,
  });
  const store = new WorkersStore(root, {
    pollMs: 60_000,
    idleMs: 60_000,
    controlClient: client,
  });
  t.after(() => store.dispose());
  await store.refresh();
  await store.refreshControl(true);

  assert.equal(store.getSnapshot().control, 'offline');
  const outcome = await store.requestSteer('j_dead', 'hello');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.status, 0);
  assert.equal(outcome.error.code, 'steer_unavailable');
  assert.match(outcome.error.message, /control offline/);
  assert.equal(httpCalls, 0);
});

test('prepareSteer explains a missing capability in the footer', async (t) => {
  const root = await tempState(t);
  await writeJob(root, 'j_live', 'owner-live');

  const server = await startFakeServer((recorded, res) => {
    const url = new URL(recorded.url, 'http://127.0.0.1');
    if (recorded.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (recorded.method === 'GET' && url.pathname === '/v1/jobs') {
      sendJson(res, 200, { jobs: [jobView('j_live', 'owner-live', { steer: false })] });
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

  assert.equal(store.prepareSteer('j_live'), false);
  assert.equal(store.getSteerTarget(), undefined);
  const model = buildModel(store.getSnapshot().jobs, {
    width: 64,
    selectedId: 'j_live',
    showAll: true,
    control: {
      state: store.getSnapshot().control,
      jobs: store.getSnapshot().jobControls,
      message: store.getSnapshot().notice?.text ?? null,
    },
  });
  assert.equal(model.footer, 'steer unavailable: not available for this job');
  assert.ok(model.detail?.lines.includes('cancel ✗ · steer ✗'));

  assert.equal(store.prepareSteer('j_live'), false);
  assert.equal(store.prepareSteer('j_missing'), false);
  assert.match(store.getSnapshot().notice?.text ?? '', /steer unavailable: job not found/);
});
