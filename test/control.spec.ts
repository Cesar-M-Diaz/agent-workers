import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { CONTROL_PROTOCOL } from '../src/control/descriptor.js';
import type { ControlHealth, ControlJobs, JobView } from '../src/control/protocol.js';
import { type ControlServer, startControlServer } from '../src/control/server.js';
import { createControlService } from '../src/control/service.js';
import { JobManager } from '../src/jobs.js';
import { runCapture } from '../src/proc.js';
import type { JobSummary } from '../src/types.js';
import { VERSION } from '../src/version.js';

const fakeDsh = `#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
if (process.argv.includes('--help') || process.argv.includes('--version')) {
  process.stdout.write('fake dsh 0.0.0\\n');
  process.exit(0);
}
const emit = (value) => console.log(JSON.stringify(value));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  emit({ type: 'session', sessionId: 'session-' + process.pid, cwd: process.cwd() });
  if (prompt.includes('HANG')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('WRITE')) {
    await writeFile('worker-output.txt', 'from worker\\n');
  }
  await delay(100);
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  emit({ type: 'final', text: 'worker done' });
});
`;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  body: Record<string, unknown>;
}

describe('HTTP control API', () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let manager: JobManager;
  let control: ControlServer;
  let token: string;
  let port: number;
  let foreignJobId: string;

  function request(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const headers: Record<string, string> = { ...options.headers };
      if (!('authorization' in headers)) headers.authorization = `Bearer ${token}`;
      if (options.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        headers['content-length'] = String(Buffer.byteLength(options.body));
      }
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers,
          agent: false,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => {
            let body: Record<string, unknown> = {};
            try {
              body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
            } catch {
              body = {};
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
          });
        },
      );
      req.on('error', reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  async function health(): Promise<ControlHealth> {
    const response = await request('/v1/health');
    expect(response.status).toBe(200);
    return response.body as unknown as ControlHealth;
  }

  async function getView(jobId: string): Promise<JobView> {
    const response = await request(`/v1/jobs/${jobId}`);
    expect(response.status).toBe(200);
    return (response.body as unknown as { job: JobView }).job;
  }

  async function waitForJob(
    jobId: string,
    predicate: (job: JobSummary) => boolean,
    timeoutMs = 15_000,
  ): Promise<JobSummary> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = (await manager.statusOutput([jobId])).jobs[0];
      if (job && predicate(job)) return job;
      await delay(50);
    }
    throw new Error(`timed out waiting for job ${jobId}`);
  }

  async function writeForeignJob(id: string): Promise<void> {
    const dir = join(stateDir, 'jobs', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    await writeFile(
      join(dir, 'job.json'),
      JSON.stringify({
        schemaVersion: 1,
        id,
        backend: 'dsh',
        groupId: 'g_foreign',
        groupName: 'Foreign group',
        ownerId: 'owner-foreign',
        cwd: repo,
        profile: 'work-openrouter',
        provider: 'openrouter',
        model: 'test-model',
        access: 'read-only',
        isolation: 'none',
        timeoutMs: 60_000,
        status: 'succeeded',
        createdAt: now,
        finishedAt: now,
        stderrTail: '',
        malformedLines: 0,
        eventsCount: 0,
        toolCalls: 0,
        steps: 0,
        alerts: [],
        eventsPath: join(dir, 'events.ndjson'),
        finalPath: join(dir, 'final.md'),
        stderrPath: join(dir, 'stderr.log'),
        jobPath: join(dir, 'job.json'),
      }),
      { mode: 0o600 },
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-control-test-'));
    repo = join(root, 'repo');
    stateDir = join(root, 'state');
    const worktreeRoot = join(root, 'worktrees');
    const dshHome = join(root, 'dsh-home');
    await mkdir(repo);
    await mkdir(stateDir);
    await mkdir(worktreeRoot);
    await runCapture('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'base\n');
    await runCapture('git', ['-C', repo, 'add', '.']);
    await runCapture('git', [
      '-C',
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-qm',
      'base',
    ]);

    const fake = join(root, 'fake-dsh.mjs');
    await writeFile(fake, fakeDsh, { mode: 0o700 });
    await chmod(fake, 0o700);
    const profileDir = join(dshHome, 'profiles', 'work-openrouter');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'metadata.json'),
      JSON.stringify({ provider: 'openrouter', model: 'test-model' }),
    );

    const config: Config = {
      dshBin: fake,
      allowedRoots: [repo],
      stateDir,
      worktreeRoot,
      dshHome,
      control: true,
      maxConcurrent: 2,
      maxQueue: 8,
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      maxDepth: 2,
      retentionDays: 7,
      useDshCredentials: false,
      credentialsFile: join(root, 'credentials.yaml'),
      envAllow: ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'],
      stallMs: 120_000,
      loopRepeat: 4,
      toolErrorLimit: 5,
      watchdogAction: 'warn',
    };

    foreignJobId = 'j_foreign';
    await writeForeignJob(foreignJobId);

    manager = new JobManager(config);
    await manager.init();
    token = randomBytes(32).toString('base64url');
    control = await startControlServer({
      service: createControlService(manager),
      token,
    });
    port = control.port;
  });

  afterAll(async () => {
    await control?.close();
    await manager?.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects missing or wrong tokens and disallowed hosts and origins', async () => {
    let response = await request('/v1/health', { headers: { authorization: '' } });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'unauthorized' });

    response = await request('/v1/health', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');

    response = await request('/v1/health', {
      headers: { host: `evil.example:${port}` },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'forbidden_host' });

    response = await request('/v1/health', {
      headers: { origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'forbidden_origin' });

    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      response = await request('/v1/health', { headers: { origin } });
      expect(response.status).toBe(200);
    }
  });

  it('requires JSON bodies, enforces the 64 KB limit, and validates routes', async () => {
    let response = await request(`/v1/jobs/${foreignJobId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(response.status).toBe(415);
    expect(response.body).toMatchObject({ error: 'unsupported_media_type' });

    response = await request(`/v1/jobs/${foreignJobId}/cancel`, {
      method: 'POST',
      body: 'x'.repeat(64 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: 'body_too_large' });

    response = await request('/v1/jobs/bad$id');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_job_id' });

    response = await request(`/v1/jobs/${foreignJobId}/result?include=bogus`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_include' });

    response = await request(`/v1/jobs/${foreignJobId}/events?cursor=-1`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_cursor' });

    response = await request('/v1/jobs/j_does_not_exist');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'unknown_job' });

    response = await request('/v1/not-a-route');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'not_found' });
  });

  it('returns the health and jobs contract shapes', async () => {
    const healthPayload = await health();
    expect(healthPayload).toMatchObject({
      ok: true,
      protocol: CONTROL_PROTOCOL,
      version: VERSION,
      owner_id: manager.owner,
      pid: process.pid,
      ready: true,
      state_dir: stateDir,
      backend: 'dsh',
    });
    expect(Number.isInteger(healthPayload.max_concurrent)).toBe(true);
    expect(Number.isInteger(healthPayload.max_queue)).toBe(true);
    expect(Number.isInteger(healthPayload.running)).toBe(true);
    expect(Number.isInteger(healthPayload.queued)).toBe(true);

    const response = await request('/v1/jobs');
    expect(response.status).toBe(200);
    const payload = response.body as unknown as ControlJobs;
    expect(payload.server).toMatchObject({
      ok: true,
      protocol: CONTROL_PROTOCOL,
      owner_id: manager.owner,
      ready: true,
    });
    const foreign = payload.jobs.find((job) => job.job_id === foreignJobId);
    expect(foreign).toMatchObject({
      job_id: foreignJobId,
      owner_id: 'owner-foreign',
      owned: false,
      status: 'succeeded',
      capabilities: {
        cancel: false,
        steer: false,
        cleanup: false,
        delete: false,
      },
    });
  });

  it('reports a running job with cancel capability and never leaks the task or token', async () => {
    const task = 'SECRET_TASK_MARKER_9f2c';
    const started = await manager.start({
      task,
      label: 'running-job',
      access: 'read-only',
    });
    await waitForJob(
      started.job_id,
      (job) => job.status === 'running' && job.session_id !== undefined,
    );

    const view = await getView(started.job_id);
    expect(view).toMatchObject({
      job_id: started.job_id,
      status: 'running',
      owned: true,
      capabilities: { cancel: true, steer: true, cleanup: false, delete: false },
    });
    expect(view.worktree).toBeNull();

    const list = (await request('/v1/jobs')).body as unknown as ControlJobs;
    expect(list.jobs.find((job) => job.job_id === started.job_id)?.capabilities.cancel).toBe(true);

    for (const path of [
      '/v1/health',
      '/v1/jobs',
      `/v1/jobs/${started.job_id}`,
      `/v1/jobs/${started.job_id}/events`,
      `/v1/jobs/${started.job_id}/result`,
    ]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.text).not.toContain(task);
      expect(response.text).not.toContain(token);
    }

    const cancelled = await request(`/v1/jobs/${started.job_id}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ job_id: started.job_id, status: 'cancelled' });
    expect((await waitForJob(started.job_id, (job) => job.status === 'cancelled')).status).toBe(
      'cancelled',
    );
  });

  it('steers a running job and returns the steered job id', async () => {
    const started = await manager.start({
      task: 'HANG steer original',
      label: 'steer-job',
      access: 'read-only',
    });
    await waitForJob(
      started.job_id,
      (job) => job.status === 'running' && job.session_id !== undefined,
    );

    const response = await request(`/v1/jobs/${started.job_id}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message: 'continue' }),
    });
    expect(response.status).toBe(200);
    const steered = response.body as { job_id: string; steered_job_id: string; cancelled: boolean };
    expect(steered.job_id).toBe(started.job_id);
    expect(steered.cancelled).toBe(true);
    expect(steered.steered_job_id).toMatch(/^j_/);
    await waitForJob(steered.steered_job_id, (job) => job.status === 'succeeded');
  });

  it('cleans up and deletes a clean terminal worktree job', async () => {
    const started = await manager.start({
      task: 'quick clean worktree',
      label: 'clean-worktree',
      access: 'workspace-write',
      isolation: 'worktree',
    });
    expect(started.worktree).not.toBeNull();
    await waitForJob(started.job_id, (job) => job.status === 'succeeded');

    let view = await getView(started.job_id);
    expect(view.worktree).not.toBeNull();
    expect(view.worktree?.repo_root).toBe(repo);
    expect(view.capabilities).toMatchObject({
      cleanup: true,
      delete: true,
      cancel: false,
    });

    const cleaned = await request(`/v1/jobs/${started.job_id}/cleanup`, {
      method: 'POST',
      body: JSON.stringify({ discard_changes: false }),
    });
    expect(cleaned.status).toBe(200);
    expect(cleaned.body).toMatchObject({ job_id: started.job_id, worktree: 'removed' });

    view = await getView(started.job_id);
    expect(view.worktree?.cleaned).toBe(true);
    expect(view.capabilities.cleanup).toBe(false);

    const deleted = await request(`/v1/jobs/${started.job_id}?discard_changes=1`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ job_id: started.job_id, deleted: true });

    const missing = await request(`/v1/jobs/${started.job_id}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'unknown_job' });
  });

  it('returns 409 worktree_busy while an active job shares the worktree', async () => {
    const started = await manager.start({
      task: 'HANG shared worktree',
      label: 'busy-worktree',
      access: 'workspace-write',
      isolation: 'worktree',
    });
    expect(started.worktree).not.toBeNull();
    await waitForJob(
      started.job_id,
      (job) => job.status === 'running' && job.session_id !== undefined,
    );

    const steered = await manager.steer({
      job_id: started.job_id,
      message: 'HANG continue',
    });
    const steeredJobId = steered.steered_job_id as string;
    await waitForJob(steeredJobId, (job) => job.status === 'running');

    const view = await getView(started.job_id);
    expect(view.status).toBe('cancelled');
    expect(view.capabilities.cleanup).toBe(false);
    expect(view.capabilities.delete).toBe(false);

    const cleanup = await request(`/v1/jobs/${started.job_id}/cleanup`, {
      method: 'POST',
      body: '{}',
    });
    expect(cleanup.status).toBe(409);
    expect(cleanup.body).toMatchObject({ error: 'worktree_busy' });

    const deleted = await request(`/v1/jobs/${started.job_id}?discard_changes=1`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(409);
    expect(deleted.body).toMatchObject({ error: 'worktree_busy' });

    const cancelled = await request(`/v1/jobs/${steeredJobId}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    expect(cancelled.status).toBe(200);
    await waitForJob(steeredJobId, (job) => job.status === 'cancelled');
  });

  it('refuses actions on a foreign terminal job with not_owner', async () => {
    const view = await getView(foreignJobId);
    expect(view).toMatchObject({
      job_id: foreignJobId,
      owner_id: 'owner-foreign',
      owned: false,
      status: 'succeeded',
      capabilities: {
        cancel: false,
        steer: false,
        cleanup: false,
        delete: false,
        read_result: true,
        read_events: true,
      },
    });

    const cancel = await request(`/v1/jobs/${foreignJobId}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    expect(cancel.status).toBe(409);
    expect(cancel.body).toMatchObject({ error: 'not_owner' });

    const cleanup = await request(`/v1/jobs/${foreignJobId}/cleanup`, {
      method: 'POST',
      body: '{}',
    });
    expect(cleanup.status).toBe(409);
    expect(cleanup.body).toMatchObject({ error: 'not_owner' });

    const deleted = await request(`/v1/jobs/${foreignJobId}?discard_changes=1`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(409);
    expect(deleted.body).toMatchObject({ error: 'not_owner' });

    const events = await request(`/v1/jobs/${foreignJobId}/events`);
    expect(events.status).toBe(200);
    expect(events.body).toMatchObject({ job_id: foreignJobId, events: [] });
  });
});
