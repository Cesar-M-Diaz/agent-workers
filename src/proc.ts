import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFile,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SpawnDshOptions {
  dshBin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface KillResult {
  pids: number[];
  survivors: number[];
}

export function spawnDsh(options: SpawnDshOptions): ChildProcessWithoutNullStreams {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return spawn(options.dshBin, options.args, spawnOptions) as ChildProcessWithoutNullStreams;
}

export async function runCapture(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<CaptureResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number | string | null; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message,
    };
  }
}

export async function readStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = text
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    // /proc/<pid>/stat field 22; fields after the comm start at field 3.
    return fields[19];
  } catch {
    return undefined;
  }
}

async function descendants(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    const children = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const list = children.get(parent);
      if (list) list.push(pid);
      else children.set(parent, [pid]);
    }
    const found: number[] = [];
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const child of children.get(pid) ?? []) {
        if (!seen.has(child)) {
          found.push(child);
          queue.push(child);
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours.
  }
}

async function allDescendants(rootPid: number): Promise<number[]> {
  const direct = await descendants(rootPid);
  const all = new Set<number>([rootPid, ...direct]);
  for (const pid of direct) {
    for (const child of await descendants(pid)) all.add(child);
  }
  return [...all];
}

export async function killTreeByPid(rootPid: number): Promise<KillResult> {
  if (process.platform === 'win32') {
    await runCapture('taskkill', ['/PID', String(rootPid), '/T', '/F'], { timeoutMs: 10_000 });
    return { pids: [rootPid], survivors: [] };
  }

  const pids = new Set<number>([rootPid, ...(await allDescendants(rootPid))]);
  send(-rootPid, 'SIGTERM');
  for (const pid of pids) send(pid, 'SIGTERM');

  const graceUntil = Date.now() + 5_000;
  while (Date.now() < graceUntil) {
    const alive = [...pids].filter((pid) => isAlive(pid));
    if (alive.length === 0) return { pids: [...pids], survivors: [] };
    await delay(100);
  }

  for (const pid of await allDescendants(rootPid)) pids.add(pid);
  send(-rootPid, 'SIGKILL');
  for (const pid of pids) send(pid, 'SIGKILL');
  await delay(300);

  return { pids: [...pids], survivors: [...pids].filter((pid) => isAlive(pid)) };
}

export async function killTree(child: ChildProcess): Promise<KillResult> {
  if (!child.pid) return { pids: [], survivors: [] };
  return killTreeByPid(child.pid);
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}
