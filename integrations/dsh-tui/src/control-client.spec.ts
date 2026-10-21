import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONTROL_PROTOCOL,
  ControlClient,
  ControlRequestError,
  discoverOwners,
  type OwnerDescriptor,
} from './control-client.js';

interface DescriptorOverrides {
  owner_id?: string;
  protocol?: string;
  pid?: number;
  ready?: boolean;
  control?: unknown;
}

async function tempState(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-owners-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 });
  return root;
}

async function writeDescriptor(
  root: string,
  fileName: string,
  overrides: DescriptorOverrides = {},
): Promise<string> {
  const ownerId = fileName.slice(0, -'.json'.length);
  const path = join(root, 'control', fileName);
  const payload = {
    protocol: CONTROL_PROTOCOL,
    owner_id: ownerId,
    pid: process.pid,
    pid_start: '1',
    started_at: '2026-10-21T09:00:00.000Z',
    version: '0.5.0',
    state_dir: root,
    control: { base_url: 'http://127.0.0.1:9', port: 9, token: 'secret-token' },
    ready: true,
    ...overrides,
  };
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  assert.ok(pid !== undefined);
  return pid;
}

test('discovers only descriptors that satisfy every §6 validation rule', async (t) => {
  const root = await tempState(t);
  await writeDescriptor(root, 'owner-valid.json');

  const badMode = await writeDescriptor(root, 'owner-mode.json');
  await chmod(badMode, 0o644);

  const target = join(root, 'target.json');
  await writeFile(target, JSON.stringify({}), { mode: 0o600 });
  await symlink(target, join(root, 'control', 'owner-link.json'));

  await writeDescriptor(root, 'owner-mismatch.json', { owner_id: 'owner-other' });
  await writeDescriptor(root, 'owner-protocol.json', { protocol: 'agent-workers-control/9' });
  await writeDescriptor(root, 'owner-not-ready.json', { ready: false });
  await writeDescriptor(root, 'owner-no-control.json', { control: null });
  await writeDescriptor(root, 'owner-dead.json', { pid: await deadPid() });
  await writeFile(join(root, 'control', 'owner-broken.json'), '{not json', { mode: 0o600 });
  await chmod(join(root, 'control', 'owner-broken.json'), 0o600);
  await writeFile(join(root, 'control', 'not-an-owner.txt'), '{}', { mode: 0o600 });

  const owners = await discoverOwners(root);
  assert.deepEqual(
    owners.map((owner) => owner.owner_id),
    ['owner-valid'],
  );
  assert.equal(owners[0]?.control.token, 'secret-token');
  assert.equal(owners[0]?.ready, true);
});

test('discovery never throws for a missing or unreadable state dir', async () => {
  assert.deepEqual(await discoverOwners('/does/not/exist/dsh-tui'), []);
});

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface FakeServer {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
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
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function ownerFor(server: FakeServer, token = 'tok-123'): OwnerDescriptor {
  return {
    protocol: CONTROL_PROTOCOL,
    owner_id: 'owner-test',
    pid: process.pid,
    control: { base_url: server.baseUrl, port: Number(new URL(server.baseUrl).port), token },
    ready: true,
  };
}

const JOB_VIEW = {
  job_id: 'j_test',
  label: 'test job',
  status: 'succeeded',
  owner_id: 'owner-test',
  capabilities: {
    cancel: false,
    steer: false,
    cleanup: true,
    delete: true,
    read_result: true,
    read_events: true,
  },
};

test('control client lists jobs, calls actions with auth, and maps contract errors', async (t) => {
  const server = await startFakeServer((requested, res) => {
    if (requested.authorization !== 'Bearer tok-123') {
      sendJson(res, 401, { error: 'unauthorized', message: 'missing or invalid bearer token' });
      return;
    }
    const url = new URL(requested.url, 'http://127.0.0.1');
    if (requested.method === 'GET' && url.pathname === '/v1/jobs') {
      sendJson(res, 200, { server: { ok: true }, jobs: [JOB_VIEW] });
      return;
    }
    if (requested.method === 'POST' && url.pathname === '/v1/jobs/j_test/cancel') {
      sendJson(res, 200, { job_id: 'j_test', status: 'cancelled', killed_pids: [], survivors: [] });
      return;
    }
    if (requested.method === 'POST' && url.pathname === '/v1/jobs/j_busy/cancel') {
      sendJson(res, 409, { error: 'worktree_busy', message: 'worktree is busy', worktree: 'busy' });
      return;
    }
    if (requested.method === 'POST' && url.pathname === '/v1/jobs/j_dirty/cleanup') {
      const discard = (JSON.parse(requested.body || '{}') as { discard_changes?: boolean })
        .discard_changes;
      if (discard === true) {
        sendJson(res, 200, { job_id: 'j_dirty', worktree: 'removed', branch_deleted: true });
      } else {
        sendJson(res, 200, {
          job_id: 'j_dirty',
          worktree: 'preserved_dirty',
          branch_deleted: false,
        });
      }
      return;
    }
    if (requested.method === 'DELETE' && url.pathname === '/v1/jobs/j_dirty') {
      if (url.searchParams.get('discard_changes') !== '1') {
        sendJson(res, 409, {
          error: 'worktree_dirty',
          message: 'worktree has changes',
          worktree: 'preserved_dirty',
        });
        return;
      }
      sendJson(res, 200, {
        job_id: 'j_dirty',
        deleted: true,
        worktree: 'removed',
        branch_deleted: true,
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found', message: 'unknown route' });
  });
  t.after(async () => server.close());

  const client = new ControlClient();
  const owner = ownerFor(server);
  const jobs = await client.listJobs(owner);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.job_id, 'j_test');
  assert.equal(jobs[0]?.capabilities.cleanup, true);
  assert.equal(server.requests[0]?.authorization, 'Bearer tok-123');

  const cancelled = await client.cancel(owner, 'j_test');
  assert.equal(cancelled.status, 'cancelled');
  const cancelRequest = server.requests.at(-1);
  assert.equal(cancelRequest?.method, 'POST');
  assert.equal(cancelRequest?.contentType, 'application/json');
  assert.equal(cancelRequest?.body, '{}');

  await assert.rejects(
    client.cancel(owner, 'j_busy'),
    (error: unknown) =>
      error instanceof ControlRequestError &&
      error.status === 409 &&
      error.code === 'worktree_busy' &&
      error.worktree === 'busy',
  );

  const preserved = await client.cleanup(owner, 'j_dirty', false);
  assert.equal(preserved.worktree, 'preserved_dirty');
  assert.equal(JSON.parse(server.requests.at(-1)?.body ?? '{}').discard_changes, false);

  const removed = await client.cleanup(owner, 'j_dirty', true);
  assert.equal(removed.worktree, 'removed');
  assert.equal(JSON.parse(server.requests.at(-1)?.body ?? '{}').discard_changes, true);

  await assert.rejects(
    client.remove(owner, 'j_dirty', false),
    (error: unknown) =>
      error instanceof ControlRequestError &&
      error.status === 409 &&
      error.code === 'worktree_dirty' &&
      error.worktree === 'preserved_dirty',
  );

  const deleted = await client.remove(owner, 'j_dirty', true);
  assert.equal(deleted.deleted, true);
  const deleteRequest = server.requests.at(-1);
  assert.equal(deleteRequest?.method, 'DELETE');
  assert.match(deleteRequest?.url ?? '', /discard_changes=1/);
});

test('maps a 401 response to a typed unauthorized error', async (t) => {
  const server = await startFakeServer((_requested, res) => {
    sendJson(res, 401, { error: 'unauthorized', message: 'bad token' });
  });
  t.after(async () => server.close());

  const client = new ControlClient();
  await assert.rejects(
    client.listJobs(ownerFor(server, 'wrong-token')),
    (error: unknown) =>
      error instanceof ControlRequestError && error.status === 401 && error.code === 'unauthorized',
  );
});

test('health times out at the configured limit and backs off before retrying', async (t) => {
  let hits = 0;
  const server = await startFakeServer((requested, res) => {
    hits += 1;
    const timer = setTimeout(() => {
      if (!res.writableEnded) sendJson(res, 200, { ok: true });
    }, 500);
    res.once('close', () => clearTimeout(timer));
    assert.equal(requested.url, '/v1/health');
  });
  t.after(async () => server.close());

  let clock = 1000;
  const client = new ControlClient('', { timeoutMs: 60, now: () => clock });
  const owner = ownerFor(server);

  assert.equal(await client.health(owner), false);
  assert.equal(hits, 1);

  clock += 500;
  assert.equal(await client.health(owner), false);
  assert.equal(hits, 1);

  clock += 600;
  assert.equal(await client.health(owner), false);
  assert.equal(hits, 2);
  await delay(0);
});
