import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const serverPath = fileURLToPath(new URL('../plugin-dist/server.mjs', import.meta.url));
const uiPath = fileURLToPath(new URL('../plugin-dist/ui.mjs', import.meta.url));

interface RpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

class RpcClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (value: RpcResponse) => void>();

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
          const resolve = this.pending.get(message.id);
          if (resolve) {
            this.pending.delete(message.id);
            resolve(message);
          }
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = this.nextId++;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, resolve);
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

const fakeDsh = `#!/usr/bin/env node
if (process.argv.includes('--help') || process.argv.includes('--version')) {
  process.stdout.write('fake dsh 0.0.0\\n');
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

describe('committed plugin bundle', () => {
  let root: string;
  let child: ChildProcessWithoutNullStreams;
  let rpc: RpcClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-bundle-test-'));
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

  it('is up to date with a deterministic pnpm bundle', async () => {
    const { stdout } = await run(process.execPath, ['scripts/bundle.mjs', '--check'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
    });
    expect(stdout).toContain('plugin-dist is up to date');
    const info = await stat(serverPath);
    expect(info.size).toBeGreaterThan(100_000);
  });

  it('answers MCP initialize and tools/list over stdio', async () => {
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bundle-test', version: '1.0.0' },
    });
    expect(init.error).toBeUndefined();
    rpc.notify('notifications/initialized', {});

    const tools = await rpc.request('tools/list', {});
    const names = ((tools.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('worker_steer');
    expect(names).toContain('worker_delete');
    expect(names.sort()).toEqual([
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
  });

  it('prints UI help from the bundled entry point', async () => {
    const { stdout } = await run(process.execPath, [uiPath, '--help']);
    expect(stdout).toContain('agent-workers-ui');
    expect(stdout).toContain('Usage:');
  });

  it('keeps the manifest version in sync with package.json', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const manifest = JSON.parse(
      await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string };
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.name).toBe('agent-workers');
    expect(manifest.version).toBe(packageJson.version);
  });
});
