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
    root = await mkdtemp(join(tmpdir(), 'dsh-workers-ui-test-'));
    const jobDir = join(root, 'jobs', 'j_test');
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, 'job.json'),
      JSON.stringify({
        id: 'j_test',
        label: 'test worker',
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
      }),
    );
    await writeFile(
      join(jobDir, 'events.ndjson'),
      [
        JSON.stringify({ type: 'session', sessionId: 's1' }),
        JSON.stringify({ type: 'tool_call', tool: 'bash', input: { command: 'pwd' } }),
      ].join('\n'),
    );
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
    expect(health.name).toBe('dsh-workers-ui');
    expect(health.state_dir).toBe(root);

    const body = (await fetch(`${baseUrl}/api/jobs`).then((response) => response.json())) as {
      jobs: Array<{ id: string; label: string; status: string }>;
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ id: 'j_test', label: 'test worker', status: 'running' });
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

  it('serves the dashboard HTML', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('DSH Workers');
  });
});
