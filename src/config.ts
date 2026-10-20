import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome, resolveAllowedRoots } from './paths.js';

export interface Config {
  dshBin: string;
  allowedRoots: string[];
  stateDir: string;
  worktreeRoot: string;
  dshHome: string;
  maxConcurrent: number;
  maxQueue: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxDepth: number;
  retentionDays: number;
  useDshCredentials: boolean;
  credentialsFile: string;
  envAllow: string[];
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function isReadOnlyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EROFS' || code === 'EACCES' || code === 'EPERM';
}

/**
 * The configured state tree may live under a read-only home (some managed
 * environments mount /home read-only). Keep stdout pure and fall back to a
 * per-user temporary state tree when the configured directory cannot be
 * created or made private. The fallback is reported on stderr.
 */
async function ensurePrivateDir(path: string, fallbackName: string): Promise<string> {
  const dir = resolve(expandHome(path));
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error('not a directory');
    await chmod(dir, 0o700);
    return dir;
  } catch (err) {
    if (!isReadOnlyError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`state directory is not usable: ${dir}: ${message}`);
    }
    const fallback = join(tmpdir(), 'dsh-workers', fallbackName);
    await mkdir(fallback, { recursive: true, mode: 0o700 });
    await chmod(fallback, 0o700);
    process.stderr.write(
      `${JSON.stringify({
        event: 'state_dir_fallback',
        requested: dir,
        used: fallback,
        reason: (err as NodeJS.ErrnoException).code,
      })}\n`,
    );
    return fallback;
  }
}

function defaultStateDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return join(xdgStateHome, 'dsh-workers');
  return join(homedir(), '.local', 'state', 'dsh-workers');
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[:,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function resolveWorkerStateDir(): Promise<string> {
  return ensurePrivateDir(process.env.DSH_WORKERS_STATE_DIR ?? defaultStateDir(), 'state');
}

export async function loadConfig(): Promise<Config> {
  const stateDir = await resolveWorkerStateDir();
  const worktreeRoot = await ensurePrivateDir(
    process.env.DSH_WORKERS_WORKTREE_ROOT ?? join(stateDir, 'worktrees'),
    'worktrees',
  );
  const dshHome = await ensurePrivateDir(
    process.env.DSH_WORKERS_DSH_HOME ?? join(stateDir, 'dsh-home'),
    'dsh-home',
  );

  const rootValues = splitList(process.env.DSH_WORKERS_ALLOWED_ROOTS);
  if (rootValues.length === 0) rootValues.push(process.cwd());
  const allowedRoots = await resolveAllowedRoots(rootValues);

  const envAllow = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'TZ',
    'NO_COLOR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'DEEPSEEK_BASE_URL',
    ...splitList(process.env.DSH_WORKERS_ENV_ALLOW),
  ];

  return {
    dshBin: process.env.DSH_WORKERS_DSH_BIN
      ? resolve(expandHome(process.env.DSH_WORKERS_DSH_BIN))
      : 'dsh',
    allowedRoots,
    stateDir,
    worktreeRoot,
    dshHome,
    maxConcurrent: intEnv('DSH_WORKERS_MAX_CONCURRENT', 3, 1, 8),
    maxQueue: intEnv('DSH_WORKERS_MAX_QUEUE', 16, 0, 64),
    defaultTimeoutMs: intEnv('DSH_WORKERS_DEFAULT_TIMEOUT_S', 1200, 60, 3600) * 1000,
    maxTimeoutMs: intEnv('DSH_WORKERS_MAX_TIMEOUT_S', 3600, 60, 3600) * 1000,
    maxDepth: intEnv('DSH_WORKERS_MAX_DEPTH', 2, 0, 8),
    retentionDays: intEnv('DSH_WORKERS_RETENTION_DAYS', 7, 0, 3650),
    useDshCredentials: boolEnv('DSH_WORKERS_USE_DSH_CREDENTIALS'),
    credentialsFile: resolve(
      expandHome(
        process.env.DSH_WORKERS_CREDENTIALS_FILE ?? join(homedir(), '.dsh', '.credentials.yaml'),
      ),
    ),
    envAllow: [...new Set(envAllow)],
  };
}

/** The key is only read when the operator opted in. It is never logged or returned. */
export async function resolveApiKey(config: Config): Promise<string | undefined> {
  const direct = process.env.DEEPSEEK_API_KEY?.trim();
  if (direct) return direct;
  if (!config.useDshCredentials) return undefined;
  try {
    const text = await readFile(config.credentialsFile, 'utf8');
    const match = /^\s*DEEPSEEK_API_KEY:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/m.exec(text);
    return match?.[1] ?? match?.[2] ?? match?.[3];
  } catch {
    return undefined;
  }
}
