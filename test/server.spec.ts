import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type OwnerDescriptor, readDescriptors } from '../src/control/descriptor.js';

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));

const fakeDsh = `#!/usr/bin/env node
if (process.argv.includes('--help') || process.argv.includes('--version')) {
  process.stdout.write('fake dsh 0.0.0\\n');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'session', sessionId: 'session-' + process.pid, cwd: process.cwd() }));
  console.log(JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }));
  console.log(JSON.stringify({ type: 'final', text: 'MCP OK ' + prompt.trim() }));
});
`;

interface RpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

class RpcClient {
  readonly lines: string[] = [];
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (value: RpcResponse) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.lines.push(line);
        const message = JSON.parse(line) as RpcResponse;
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = this.nextId++;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 10_000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

function toolPayload(response: RpcResponse): Record<string, unknown> {
  const content = response.result?.content as Array<{ text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (typeof text !== 'string')
    throw new Error(`missing MCP tool content: ${JSON.stringify(response)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function waitForDescriptor(
  stateDir: string,
  predicate: (descriptor: OwnerDescriptor) => boolean = () => true,
): Promise<OwnerDescriptor> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const descriptor = (await readDescriptors(stateDir)).find(predicate);
    if (descriptor) return descriptor;
    await delay(50);
  }
  throw new Error(`timed out waiting for an owner descriptor in ${stateDir}`);
}

describe('MCP server', () => {
  let root: string;
  let child: ChildProcessWithoutNullStreams;
  let rpc: RpcClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-mcp-test-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    const fake = join(root, 'fake-dsh.mjs');
    await writeFile(fake, fakeDsh, { mode: 0o700 });
    await chmod(fake, 0o700);
    for (const profile of ['work-openrouter', 'personal-deepseek', 'personal-opencode']) {
      await mkdir(join(root, 'dsh-home', 'profiles', profile), { recursive: true });
    }
    child = spawn(process.execPath, [serverPath], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENT_WORKERS_DSH_BIN: fake,
        AGENT_WORKERS_ALLOWED_ROOTS: repo,
        AGENT_WORKERS_STATE_DIR: join(root, 'state'),
        AGENT_WORKERS_WORKTREE_ROOT: join(root, 'worktrees'),
        AGENT_WORKERS_DSH_HOME: join(root, 'dsh-home'),
        AGENT_WORKERS_MAX_CONCURRENT: '1',
        AGENT_WORKERS_MAX_QUEUE: '2',
        AGENT_WORKERS_MAX_DEPTH: '2',
        AGENT_WORKERS_USE_DSH_CREDENTIALS: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rpc = new RpcClient(child);
  });

  afterAll(async () => {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    await rm(root, { recursive: true, force: true });
  });

  it('initializes, lists the eleven tools, and runs a worker', async () => {
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    expect(init.error).toBeUndefined();
    rpc.notify('notifications/initialized', {});

    const descriptor = await waitForDescriptor(
      join(root, 'state'),
      (candidate) => candidate.control !== null,
    );
    expect(descriptor.control?.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(descriptor.control?.port).toBeTruthy();
    expect(descriptor.control?.token).toBeTruthy();
    const healthResponse = await fetch(`${descriptor.control?.base_url}/v1/health`, {
      headers: { authorization: `Bearer ${descriptor.control?.token}` },
    });
    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as {
      ok: boolean;
      ready: boolean;
      owner_id: string;
    };
    expect(health).toMatchObject({ ok: true, ready: true, owner_id: descriptor.owner_id });

    const tools = await rpc.request('tools/list', {});
    const listed = (tools.result?.tools ?? []) as Array<{
      name: string;
      inputSchema?: {
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };
    }>;
    const names = listed.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'worker_cancel',
      'worker_cleanup',
      'worker_delete',
      'worker_events',
      'worker_group',
      'worker_profile',
      'worker_result',
      'worker_start',
      'worker_status',
      'worker_steer',
      'worker_wait',
    ]);

    const steer = listed.find((tool) => tool.name === 'worker_steer');
    expect(steer?.inputSchema?.required).toEqual(expect.arrayContaining(['job_id', 'message']));
    expect(Object.keys(steer?.inputSchema?.properties ?? {}).sort()).toEqual([
      'job_id',
      'message',
      'timeout_s',
    ]);
    expect(steer?.inputSchema?.additionalProperties).toBe(false);

    const profile = await rpc.request('tools/call', {
      name: 'worker_profile',
      arguments: {},
    });
    const profilePayload = toolPayload(profile) as { profile: string; profiles: string[] };
    expect(profilePayload.profile).toBe('work-openrouter');
    expect(profilePayload.profiles).toEqual([
      'personal-deepseek',
      'personal-opencode',
      'work-openrouter',
    ]);

    const started = await rpc.request('tools/call', {
      name: 'worker_start',
      arguments: { task: 'hello', group_id: 'g_test', group_name: 'Test group' },
    });
    const startPayload = toolPayload(started) as {
      job_id: string;
      profile: string;
      group_id: string;
      group_name: string;
    };
    expect(startPayload.job_id).toMatch(/^j_/);
    expect(startPayload.profile).toBe('work-openrouter');
    expect(startPayload.group_id).toBe('g_test');
    expect(startPayload.group_name).toBe('Test group');

    const waited = await rpc.request('tools/call', {
      name: 'worker_wait',
      arguments: { job_ids: [startPayload.job_id], mode: 'all', timeout_s: 5 },
    });
    const waitPayload = toolPayload(waited) as { jobs: Array<{ status: string }> };
    expect(waitPayload.jobs[0]?.status).toBe('succeeded');

    const result = await rpc.request('tools/call', {
      name: 'worker_result',
      arguments: { job_id: startPayload.job_id },
    });
    const resultPayload = toolPayload(result) as { final: string };
    expect(resultPayload.final).toBe('MCP OK hello');

    const events = await rpc.request('tools/call', {
      name: 'worker_events',
      arguments: { job_id: startPayload.job_id, cursor: 0, limit: 10 },
    });
    const eventPayload = toolPayload(events) as {
      events: Array<{ type: string }>;
      next_cursor: number;
    };
    expect(eventPayload.events.map((event) => event.type)).toEqual(['session', 'status', 'final']);
    expect(eventPayload.next_cursor).toBe(3);

    const group = await rpc.request('tools/call', {
      name: 'worker_group',
      arguments: { group_id: 'g_next', group_name: 'Next group' },
    });
    expect(toolPayload(group)).toMatchObject({ group_id: 'g_next', group_name: 'Next group' });

    const deleted = await rpc.request('tools/call', {
      name: 'worker_delete',
      arguments: { job_id: startPayload.job_id },
    });
    expect(toolPayload(deleted)).toMatchObject({ job_id: startPayload.job_id, deleted: true });

    expect(rpc.lines.length).toBeGreaterThan(0);
    for (const line of rpc.lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  it('leaves control null when AGENT_WORKERS_CONTROL=0', async () => {
    const stateDir = join(root, 'state-off');
    const off = spawn(process.execPath, [serverPath], {
      cwd: join(root, 'repo'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENT_WORKERS_DSH_BIN: join(root, 'fake-dsh.mjs'),
        AGENT_WORKERS_ALLOWED_ROOTS: join(root, 'repo'),
        AGENT_WORKERS_STATE_DIR: stateDir,
        AGENT_WORKERS_WORKTREE_ROOT: join(root, 'worktrees-off'),
        AGENT_WORKERS_DSH_HOME: join(root, 'dsh-home'),
        AGENT_WORKERS_MAX_CONCURRENT: '1',
        AGENT_WORKERS_MAX_QUEUE: '2',
        AGENT_WORKERS_MAX_DEPTH: '2',
        AGENT_WORKERS_USE_DSH_CREDENTIALS: '0',
        AGENT_WORKERS_CONTROL: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const offRpc = new RpcClient(off);
    try {
      const init = await offRpc.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      });
      expect(init.error).toBeUndefined();
      const descriptor = await waitForDescriptor(stateDir);
      expect(descriptor.control).toBeNull();
      expect(descriptor.ready).toBe(true);
      expect(offRpc.lines.length).toBeGreaterThan(0);
      for (const line of offRpc.lines) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
      }
    } finally {
      off.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (off.exitCode !== null) return resolve();
        off.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
  });
});
