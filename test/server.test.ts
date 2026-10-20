import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('MCP server', () => {
  let root: string;
  let child: ChildProcessWithoutNullStreams;
  let rpc: RpcClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workers-mcp-test-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    const fake = join(root, 'fake-dsh.mjs');
    await writeFile(fake, fakeDsh, { mode: 0o700 });
    await chmod(fake, 0o700);
    child = spawn(process.execPath, [serverPath], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DSH_WORKERS_DSH_BIN: fake,
        DSH_WORKERS_ALLOWED_ROOTS: repo,
        DSH_WORKERS_STATE_DIR: join(root, 'state'),
        DSH_WORKERS_WORKTREE_ROOT: join(root, 'worktrees'),
        DSH_WORKERS_DSH_HOME: join(root, 'dsh-home'),
        DSH_WORKERS_MAX_CONCURRENT: '1',
        DSH_WORKERS_MAX_QUEUE: '2',
        DSH_WORKERS_MAX_DEPTH: '2',
        DSH_WORKERS_USE_DSH_CREDENTIALS: '0',
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

  it('initializes, lists the six tools, and runs a worker', async () => {
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    expect(init.error).toBeUndefined();
    rpc.notify('notifications/initialized', {});

    const tools = await rpc.request('tools/list', {});
    const listed = (tools.result?.tools ?? []) as Array<{ name: string }>;
    const names = listed.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'dsh_cancel',
      'dsh_cleanup',
      'dsh_result',
      'dsh_start',
      'dsh_status',
      'dsh_wait',
    ]);

    const started = await rpc.request('tools/call', {
      name: 'dsh_start',
      arguments: { task: 'hello' },
    });
    const startPayload = toolPayload(started) as { job_id: string };
    expect(startPayload.job_id).toMatch(/^j_/);

    const waited = await rpc.request('tools/call', {
      name: 'dsh_wait',
      arguments: { job_ids: [startPayload.job_id], mode: 'all', timeout_s: 5 },
    });
    const waitPayload = toolPayload(waited) as { jobs: Array<{ status: string }> };
    expect(waitPayload.jobs[0]?.status).toBe('succeeded');

    const result = await rpc.request('tools/call', {
      name: 'dsh_result',
      arguments: { job_id: startPayload.job_id },
    });
    const resultPayload = toolPayload(result) as { final: string };
    expect(resultPayload.final).toBe('MCP OK hello');
  });
});
