import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboardServer } from '../src/ui.js';

describe('dashboard API', () => {
  let root: string;
  let server: ReturnType<typeof createDashboardServer>;
  let baseUrl: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-ui-test-'));
    const jobDir = join(root, 'jobs', 'j_test');
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, 'job.json'),
      JSON.stringify({
        id: 'j_test',
        label: 'test worker',
        groupId: 'g_ui',
        groupName: 'UI test session',
        ownerId: 'owner_ui',
        status: 'running',
        cwd: '/tmp',
        access: 'read-only',
        isolation: 'none',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        steps: 1,
        toolCalls: 2,
        lastTool: 'bash',
        eventsCount: 2,
        profile: 'work-openrouter',
        provider: 'openrouter',
        model: '~deepseek/deepseek-flash-latest',
        effort: 'max',
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          totalTokens: 2000,
          cacheReadTokens: 900,
        },
        costUsd: 0.0002,
        alerts: [
          {
            kind: 'loop',
            message: 'same bash call repeated 5× in last 10',
            since: new Date().toISOString(),
          },
        ],
      }),
    );
    await writeFile(
      join(jobDir, 'events.ndjson'),
      [
        JSON.stringify({ type: 'session', sessionId: 's1' }),
        JSON.stringify({ type: 'tool_call', tool: 'bash', input: { command: 'pwd' } }),
      ].join('\n'),
    );
    const doneDir = join(root, 'jobs', 'j_done');
    await mkdir(doneDir, { recursive: true });
    await writeFile(
      join(doneDir, 'job.json'),
      JSON.stringify({
        id: 'j_done',
        label: 'done worker',
        groupId: 'g_ui',
        groupName: 'UI test session',
        ownerId: 'owner_ui',
        status: 'succeeded',
        cwd: '/tmp',
        access: 'read-only',
        isolation: 'none',
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    );
    await writeFile(join(doneDir, 'events.ndjson'), '');
    server = createDashboardServer(root);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });

  it('reports health and lists persisted jobs', async () => {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    expect(health.name).toBe('agent-workers-ui');
    expect(health.state_dir).toBe(root);

    const body = (await fetch(`${baseUrl}/api/jobs`).then((response) => response.json())) as {
      jobs: Array<{ id: string; label: string; status: string }>;
    };
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs.find((job) => job.id === 'j_done')).not.toHaveProperty('effort');
    expect(body.jobs).toContainEqual(
      expect.objectContaining({
        id: 'j_test',
        label: 'test worker',
        status: 'running',
        group_id: 'g_ui',
        group_name: 'UI test session',
        profile: 'work-openrouter',
        provider: 'openrouter',
        model: '~deepseek/deepseek-flash-latest',
        effort: 'max',
        cost_usd: 0.0002,
        alerts: [
          expect.objectContaining({
            kind: 'loop',
            message: 'same bash call repeated 5× in last 10',
          }),
        ],
        usage: expect.objectContaining({
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 900,
        }),
      }),
    );
  });

  it('returns cursor-based live events', async () => {
    const first = (await fetch(`${baseUrl}/api/jobs/j_test/events?cursor=0&limit=1`).then(
      (response) => response.json(),
    )) as {
      events: Array<{ type: string }>;
      next_cursor: number;
      total_events: number;
    };
    expect(first.events.map((event) => event.type)).toEqual(['session']);
    expect(first.next_cursor).toBe(1);
    expect(first.total_events).toBe(2);

    const second = (await fetch(
      `${baseUrl}/api/jobs/j_test/events?cursor=${first.next_cursor}&limit=10`,
    ).then((response) => response.json())) as { events: Array<{ type: string }> };
    expect(second.events.map((event) => event.type)).toEqual(['tool_call']);
  });

  it('refuses to delete active jobs and deletes terminal records', async () => {
    const active = await fetch(`${baseUrl}/api/jobs/j_test`, { method: 'DELETE' });
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({ error: 'job_active' });

    const done = await fetch(`${baseUrl}/api/jobs/j_done`, { method: 'DELETE' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ job_id: 'j_done', deleted: true });

    const missing = await fetch(`${baseUrl}/api/jobs/j_done`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('serves the dashboard HTML', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Agent Workers');
    expect(html).toContain('.empty[hidden], .job-view[hidden] { display: none; }');
    expect(html).toContain('tokens in');
    expect(html).toContain('cache read');
    expect(html).toContain("addMeta('cost'");
  });
});
