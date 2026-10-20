#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteJobRecord, JobAdminError, pruneExpiredJobs } from './admin.js';
import { loadConfig } from './config.js';
import { listDashboardJobs } from './dashboard.js';
import { readEventPage } from './events.js';
import { VERSION } from './version.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47_100;
const DASHBOARD_HTML = new URL('./dashboard.html', import.meta.url);

interface CliOptions {
  port: number;
  open: boolean;
  detach: boolean;
  serve: boolean;
  job?: string;
  help: boolean;
  version: boolean;
}

export interface DashboardOptions {
  retentionDays?: number;
  pruneIntervalMs?: number;
  worktreeRoot?: string;
}

function parsePort(raw: string | undefined): number {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`invalid port: ${raw ?? ''}`);
  }
  return value;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    port: parsePort(process.env.DSH_WORKERS_UI_PORT),
    open: true,
    detach: false,
    serve: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '--port':
        index += 1;
        options.port = parsePort(args[index]);
        break;
      case '--job':
        index += 1;
        if (args[index] === undefined || args[index] === '')
          throw new Error('--job needs a job id');
        options.job = args[index];
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--open':
        options.open = true;
        break;
      case '--detach':
        options.detach = true;
        break;
      case '--serve':
        options.serve = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-V':
        options.version = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function helpText(): string {
  return `dsh-workers-ui ${VERSION}

Usage:
  dsh-workers-ui [options]

Options:
  --port <n>   Local HTTP port (default: ${DEFAULT_PORT} or DSH_WORKERS_UI_PORT)
  --job <id>   Open the dashboard focused on one job
  --no-open    Do not open a browser
  --detach     Start a background dashboard and return
  --serve      Internal: run the server in the foreground
  --help       Show this help
  --version    Show the version

Environment:
  DSH_WORKERS_STATE_DIR   Worker state directory
  DSH_WORKERS_UI_PORT     Default dashboard port
`;
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function writeError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message });
}

function isSafeJobId(jobId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(jobId);
}

function parseCursor(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid cursor: ${raw}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  stateDir: string,
  retentionDays: number,
  url: URL,
): Promise<void> {
  const jobId = url.searchParams.get('job_id');
  if (jobId !== null && !isSafeJobId(jobId)) {
    writeError(res, 400, 'invalid job id');
    return;
  }
  let cursor = parseCursor(url.searchParams.get('cursor'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');

  let closed = false;
  req.once('close', () => {
    closed = true;
  });

  while (!closed) {
    try {
      const jobs = await listDashboardJobs(stateDir);
      sendSse(res, 'jobs', {
        server: {
          name: 'dsh-workers-ui',
          version: VERSION,
          state_dir: stateDir,
          retention_days: retentionDays,
        },
        jobs,
      });

      if (jobId !== null) {
        const page = await readEventPage(
          join(stateDir, 'jobs', jobId, 'events.ndjson'),
          cursor,
          500,
        );
        if (page.total_events < cursor) {
          cursor = 0;
          sendSse(res, 'reset', { job_id: jobId });
        } else if (page.events.length > 0) {
          cursor = page.next_cursor;
          sendSse(res, 'events', { job_id: jobId, ...page });
        }
      }
    } catch (err) {
      sendSse(res, 'stream_error', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    await delay(750);
  }
  if (!res.writableEnded) res.end();
}

export function createDashboardServer(stateDir: string, options: DashboardOptions = {}): Server {
  const retentionDays = options.retentionDays ?? 0;
  const worktreeRoot = options.worktreeRoot ?? join(stateDir, 'worktrees');
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}`);
        const deleteMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
        if (deleteMatch && req.method === 'DELETE') {
          const jobId = decodeURIComponent(deleteMatch[1]!);
          if (!isSafeJobId(jobId)) {
            writeError(res, 400, 'invalid job id');
            return;
          }
          const discard = ['1', 'true', 'yes'].includes(
            (url.searchParams.get('discard_changes') ?? '').toLowerCase(),
          );
          try {
            writeJson(
              res,
              200,
              await deleteJobRecord(stateDir, jobId, { discardChanges: discard, worktreeRoot }),
            );
          } catch (err) {
            if (err instanceof JobAdminError) {
              writeJson(res, err.status, { error: err.code, message: err.message, ...err.details });
            } else {
              throw err;
            }
          }
          return;
        }
        if (req.method !== 'GET') {
          writeError(res, 405, 'method not allowed');
          return;
        }
        if (url.pathname === '/') {
          const html = await readFile(DASHBOARD_HTML, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
              "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
          });
          res.end(html);
          return;
        }
        if (url.pathname === '/api/health') {
          writeJson(res, 200, {
            name: 'dsh-workers-ui',
            version: VERSION,
            state_dir: stateDir,
            retention_days: retentionDays,
            pid: process.pid,
          });
          return;
        }
        if (url.pathname === '/api/jobs') {
          writeJson(res, 200, {
            server: {
              name: 'dsh-workers-ui',
              version: VERSION,
              state_dir: stateDir,
              retention_days: retentionDays,
            },
            jobs: await listDashboardJobs(stateDir),
          });
          return;
        }
        if (url.pathname === '/api/stream') {
          await streamDashboard(req, res, stateDir, retentionDays, url);
          return;
        }

        const match = /^\/api\/jobs\/([^/]+)\/events$/.exec(url.pathname);
        if (match) {
          const jobId = decodeURIComponent(match[1]!);
          if (!isSafeJobId(jobId)) {
            writeError(res, 400, 'invalid job id');
            return;
          }
          const cursor = parseCursor(url.searchParams.get('cursor'));
          const limitRaw = url.searchParams.get('limit');
          const limit = limitRaw === null ? 500 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            writeError(res, 400, 'invalid limit');
            return;
          }
          writeJson(res, 200, {
            job_id: jobId,
            ...(await readEventPage(join(stateDir, 'jobs', jobId, 'events.ndjson'), cursor, limit)),
          });
          return;
        }

        writeError(res, 404, 'not found');
      } catch (err) {
        if (!res.headersSent) {
          writeError(res, 500, err instanceof Error ? err.message : String(err));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });

  if (retentionDays > 0) {
    let pruning = false;
    const prune = async (): Promise<void> => {
      if (pruning) return;
      pruning = true;
      try {
        await pruneExpiredJobs(stateDir, retentionDays, worktreeRoot);
      } finally {
        pruning = false;
      }
    };
    void prune();
    const timer = setInterval(() => void prune(), options.pruneIntervalMs ?? 15 * 60 * 1000);
    timer.unref();
    server.once('close', () => clearInterval(timer));
  }

  return server;
}

function statusUrl(port: number, job?: string): string {
  const base = `http://${HOST}:${port}/`;
  return job === undefined ? base : `${base}#${encodeURIComponent(job)}`;
}

async function probeDashboard(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { name?: string };
    return body.name === 'dsh-workers-ui';
  } catch {
    return false;
  }
}

async function waitForDashboard(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDashboard(port)) return true;
    await delay(100);
  }
  return false;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((done, fail) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      fail(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      done();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function startForeground(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const stateDir = config.stateDir;
  const server = createDashboardServer(stateDir, {
    retentionDays: config.retentionDays,
    worktreeRoot: config.worktreeRoot,
  });
  await listen(server, options.port);
  const url = statusUrl(options.port, options.job);
  process.stdout.write(`dsh-workers ui ${VERSION}\n${url}\nstate: ${stateDir}\n`);
  if (options.open) openBrowser(url);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function startDetached(options: CliOptions): Promise<void> {
  const url = statusUrl(options.port, options.job);
  const existing = await probeDashboard(options.port);
  if (existing) {
    process.stdout.write(`${url}\n`);
    if (options.open) openBrowser(url);
    return;
  }

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--serve',
      '--port',
      String(options.port),
      '--no-open',
      ...(options.job === undefined ? [] : ['--job', options.job]),
    ],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  child.unref();

  if (!(await waitForDashboard(options.port))) {
    throw new Error(`dashboard did not start on port ${options.port}`);
  }
  process.stdout.write(`${url}\n`);
  if (options.open) openBrowser(url);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (options.detach) {
    await startDetached(options);
  } else {
    await startForeground(options);
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main().catch((err: unknown) => {
    process.stderr.write(`dsh-workers ui: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
