import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome, resolveAllowedRoots } from './paths.js';

export interface Config {
  backend?: 'dsh' | 'pi';
  dshBin: string;
  piBin?: string;
  piDefaultProfile?: string;
  piProfilesFile?: string;
  piModel?: string;
  piThinking?: string;
  piAgentDir?: string;
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
  stallMs: number;
  loopRepeat: number;
  toolErrorLimit: number;
  maxSteps?: number;
  maxCostUsd?: number;
  watchdogAction: 'warn' | 'cancel';
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

function optionalIntEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function floatEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function enumEnv<T extends string>(name: string, fallback: T, values: readonly T[]): T {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return value as T;
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

/** An env path, or undefined when unset or blank (plugin userConfig passes ""). */
function pathEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export async function resolveWorkerStateDir(): Promise<string> {
  return ensurePrivateDir(pathEnv('DSH_WORKERS_STATE_DIR') ?? defaultStateDir(), 'state');
}

export async function loadConfig(): Promise<Config> {
  const stateDir = await resolveWorkerStateDir();
  const worktreeRoot = await ensurePrivateDir(
    pathEnv('DSH_WORKERS_WORKTREE_ROOT') ?? join(stateDir, 'worktrees'),
    'worktrees',
  );
  const dshHome = await ensurePrivateDir(
    pathEnv('DSH_WORKERS_DSH_HOME') ?? join(stateDir, 'dsh-home'),
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

  const piAgentDir = pathEnv('DSH_WORKERS_PI_AGENT_DIR');
  const piProfilesFile = process.env.DSH_WORKERS_PI_PROFILES_FILE?.trim();
  return {
    backend: enumEnv<'dsh' | 'pi'>('DSH_WORKERS_BACKEND', 'dsh', ['dsh', 'pi']),
    dshBin: process.env.DSH_WORKERS_DSH_BIN
      ? resolve(expandHome(process.env.DSH_WORKERS_DSH_BIN))
      : 'dsh',
    piBin: process.env.DSH_WORKERS_PI_BIN
      ? resolve(expandHome(process.env.DSH_WORKERS_PI_BIN))
      : 'pi',
    piDefaultProfile: process.env.DSH_WORKERS_PI_PROFILE?.trim() || 'default',
    piProfilesFile: resolve(expandHome(piProfilesFile || join(stateDir, 'pi-profiles.json'))),
    piModel: process.env.DSH_WORKERS_PI_MODEL?.trim() || '',
    piThinking: process.env.DSH_WORKERS_PI_THINKING?.trim() || '',
    piAgentDir: piAgentDir ? resolve(expandHome(piAgentDir)) : '',
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
    stallMs: intEnv('DSH_WORKERS_STALL_S', 120, 30, 3600) * 1000,
    loopRepeat: intEnv('DSH_WORKERS_LOOP_REPEAT', 4, 2, 20),
    toolErrorLimit: intEnv('DSH_WORKERS_TOOL_ERROR_LIMIT', 5, 1, 50),
    maxSteps: optionalIntEnv('DSH_WORKERS_MAX_STEPS', 1, 1_000_000),
    maxCostUsd: floatEnv('DSH_WORKERS_MAX_COST_USD', 0, 1_000_000),
    watchdogAction: enumEnv('DSH_WORKERS_WATCHDOG_ACTION', 'warn', ['warn', 'cancel']),
  };
}

type CredentialConfig = Pick<Config, 'useDshCredentials' | 'credentialsFile'>;

/**
 * Reads one credential reference from the environment or, when the operator
 * opted in, from the DSH credential store. It is never logged.
 */
export async function resolveCredential(
  config: CredentialConfig,
  name: string,
): Promise<string | undefined> {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  if (!config.useDshCredentials) return undefined;
  try {
    const text = await readFile(config.credentialsFile, 'utf8');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `^\\s*${escaped}:\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))\\s*$`;
    const match = new RegExp(pattern, 'm').exec(text);
    return match?.[1] ?? match?.[2] ?? match?.[3];
  } catch {
    return undefined;
  }
}

/** The key for workers that stay on the deepseek-official route. */
export async function resolveApiKey(config: CredentialConfig): Promise<string | undefined> {
  return resolveCredential(config, 'DEEPSEEK_API_KEY');
}

/** The key for worker profiles that route through OpenRouter. */
export async function resolveOpenRouterChatApiKey(
  config: CredentialConfig,
): Promise<string | undefined> {
  return resolveCredential(config, 'OPENROUTER_CHAT_API_KEY');
}

/** The key for worker profiles that route through OpenCode Go. */
export async function resolveOpenCodeGoApiKey(
  config: CredentialConfig,
): Promise<string | undefined> {
  return resolveCredential(config, 'OPENCODE_GO_API_KEY');
}
