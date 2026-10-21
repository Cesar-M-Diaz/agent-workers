/**
 * Loopback client for the agent-workers control API (`docs/control-protocol.md`
 * §3, §5 and §6). It discovers owner leases, probes their health and calls the
 * mutating routes. It never writes the state dir and never logs the token.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONTROL_PROTOCOL = 'agent-workers-control/1';
export const HEALTH_TIMEOUT_MS = 800;
export const CONTROL_BACKOFF_MS = [1000, 2000, 5000, 10000] as const;

const DESCRIPTOR_FILE = /^[A-Za-z0-9_-]+\.json$/;
const OWNER_ID = /^[A-Za-z0-9_-]+$/;

type UnknownRecord = Record<string, unknown>;

export interface ControlEndpoint {
  readonly base_url: string;
  readonly port: number;
  readonly token: string;
}

export interface OwnerDescriptor {
  readonly protocol: typeof CONTROL_PROTOCOL;
  readonly owner_id: string;
  readonly pid: number;
  readonly pid_start?: string;
  readonly started_at?: string;
  readonly version?: string;
  readonly state_dir?: string;
  readonly control: ControlEndpoint;
  readonly ready: true;
}

export interface JobCapabilities {
  cancel: boolean;
  steer: boolean;
  cleanup: boolean;
  delete: boolean;
  read_result: boolean;
  read_events: boolean;
}

export interface WorktreeView {
  path: string;
  branch: string;
  base_commit: string;
  repo_root: string;
  cleaned: boolean;
}

/** The control API representation of a job (only the fields the panel needs). */
export interface JobView {
  job_id: string;
  owner_id: string;
  status: string;
  capabilities: JobCapabilities;
  label?: string | null;
  worktree?: WorktreeView | null;
  [key: string]: unknown;
}

export interface CancelResult {
  job_id: string;
  status: string;
  killed_pids: number[];
  survivors: number[];
}

export interface CleanupResult {
  job_id: string;
  worktree: 'removed' | 'preserved_dirty' | 'none' | string;
  branch_deleted: boolean;
}

export interface DeleteResult {
  job_id: string;
  deleted: true;
  worktree: string;
  branch_deleted: boolean;
}

/** `POST /v1/jobs/:id/steer` (contract §5). */
export interface SteerResult {
  job_id: string;
  steered_job_id: string;
  cancelled: boolean;
  status: string;
  label?: string;
  group_id?: string;
  group_name?: string;
  queue_position?: number;
  cwd?: string;
  steered_from?: string;
}

export interface ControlErrorInfo {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly worktree?: string;
}

export class ControlRequestError extends Error implements ControlErrorInfo {
  readonly status: number;
  readonly code: string;
  readonly worktree?: string;

  constructor(status: number, code: string, message: string, worktree?: string) {
    super(message);
    this.name = 'ControlRequestError';
    this.status = status;
    this.code = code;
    if (worktree !== undefined) this.worktree = worktree;
  }
}

export function isControlRequestError(value: unknown): value is ControlRequestError {
  return value instanceof ControlRequestError;
}

export interface ControlClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function endpointOf(value: unknown): ControlEndpoint | undefined {
  if (!isRecord(value)) return undefined;
  const baseUrl = stringOf(value.base_url);
  const token = stringOf(value.token);
  const port = value.port;
  if (baseUrl === undefined || token === undefined) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return undefined;
  return { base_url: baseUrl, port, token };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function normalizeCapabilities(value: unknown): JobCapabilities {
  const source = isRecord(value) ? value : {};
  const flag = (key: keyof JobCapabilities, fallback: boolean): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : fallback;
  return {
    cancel: flag('cancel', false),
    steer: flag('steer', false),
    cleanup: flag('cleanup', false),
    delete: flag('delete', false),
    read_result: flag('read_result', true),
    read_events: flag('read_events', true),
  };
}

function normalizeJob(value: unknown, fallbackOwnerId: string): JobView | undefined {
  if (!isRecord(value)) return undefined;
  const jobId = stringOf(value.job_id);
  if (jobId === undefined) return undefined;
  const ownerId = stringOf(value.owner_id) ?? fallbackOwnerId;
  const status = stringOf(value.status) ?? 'unknown';
  return {
    ...value,
    job_id: jobId,
    owner_id: ownerId,
    status,
    capabilities: normalizeCapabilities(value.capabilities),
  } as JobView;
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function baseUrlOf(owner: OwnerDescriptor): string {
  const base = owner.control.base_url;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/**
 * Read and validate owner descriptors. Every failure mode (unreadable dir,
 * malformed JSON, unsafe permissions, dead pid, disabled control) is skipped
 * rather than thrown, as required by §6.
 */
export async function discoverOwners(stateDir: string): Promise<OwnerDescriptor[]> {
  const dir = join(stateDir, 'control');
  let names: string[];
  try {
    const entries = await readdir(dir);
    names = entries.filter((name) => DESCRIPTOR_FILE.test(name));
  } catch {
    return [];
  }
  names.sort();

  const owners: OwnerDescriptor[] = [];
  for (const name of names) {
    const ownerId = name.slice(0, -'.json'.length);
    if (!OWNER_ID.test(ownerId)) continue;
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if ((info.mode & 0o077) !== 0) continue;
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(parsed)) continue;
      if (parsed.protocol !== CONTROL_PROTOCOL) continue;
      if (parsed.owner_id !== ownerId) continue;
      const pid = parsed.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
      if (parsed.ready !== true) continue;
      const control = endpointOf(parsed.control);
      if (control === undefined) continue;
      if (!isPidAlive(pid)) continue;
      const descriptor: OwnerDescriptor = {
        protocol: CONTROL_PROTOCOL,
        owner_id: ownerId,
        pid,
        control,
        ready: true,
      };
      const pidStart = stringOf(parsed.pid_start);
      if (pidStart !== undefined) (descriptor as { pid_start?: string }).pid_start = pidStart;
      const startedAt = stringOf(parsed.started_at);
      if (startedAt !== undefined) (descriptor as { started_at?: string }).started_at = startedAt;
      const version = stringOf(parsed.version);
      if (version !== undefined) (descriptor as { version?: string }).version = version;
      const descriptorStateDir = stringOf(parsed.state_dir);
      if (descriptorStateDir !== undefined) {
        (descriptor as { state_dir?: string }).state_dir = descriptorStateDir;
      }
      owners.push(descriptor);
    } catch {
      // Invalid, unreadable or racing descriptors are ignored.
    }
  }
  return owners.sort((left, right) => left.owner_id.localeCompare(right.owner_id));
}

interface BackoffState {
  failures: number;
  retryAt: number;
}

export class ControlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly healthBackoff = new Map<string, BackoffState>();

  constructor(
    private readonly stateDir = '',
    options: ControlClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  discover(): Promise<OwnerDescriptor[]> {
    return discoverOwners(this.stateDir);
  }

  discoverOwners(): Promise<OwnerDescriptor[]> {
    return discoverOwners(this.stateDir);
  }

  /**
   * `true` only when the owner answered a health request within the timeout.
   * Failures are remembered per owner and skipped until the 1/2/5/10 s backoff
   * window (based on the injected clock) has elapsed.
   */
  async health(owner: OwnerDescriptor): Promise<boolean> {
    const key = `${owner.owner_id}|${owner.control.base_url}`;
    const now = this.now();
    const previous = this.healthBackoff.get(key);
    if (previous !== undefined && now < previous.retryAt) return false;

    const ok = await this.probeHealth(owner);
    if (ok) {
      this.healthBackoff.delete(key);
      return true;
    }
    const failures = (previous?.failures ?? 0) + 1;
    const index = Math.min(failures - 1, CONTROL_BACKOFF_MS.length - 1);
    const delay = CONTROL_BACKOFF_MS[index] ?? CONTROL_BACKOFF_MS.at(-1) ?? 10_000;
    this.healthBackoff.set(key, { failures, retryAt: this.now() + delay });
    return false;
  }

  resetHealthBackoff(): void {
    this.healthBackoff.clear();
  }

  async listJobs(owner: OwnerDescriptor): Promise<JobView[]> {
    const payload = await this.request<UnknownRecord>(owner, 'GET', '/v1/jobs');
    const jobs = isRecord(payload) && Array.isArray(payload.jobs) ? payload.jobs : [];
    const result: JobView[] = [];
    for (const item of jobs) {
      const job = normalizeJob(item, owner.owner_id);
      if (job !== undefined) result.push(job);
    }
    return result;
  }

  cancel(owner: OwnerDescriptor, jobId: string): Promise<CancelResult> {
    return this.request<CancelResult>(
      owner,
      'POST',
      `/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
  }

  cleanup(owner: OwnerDescriptor, jobId: string, discard: boolean): Promise<CleanupResult> {
    return this.request<CleanupResult>(
      owner,
      'POST',
      `/v1/jobs/${encodeURIComponent(jobId)}/cleanup`,
      { discard_changes: discard },
    );
  }

  remove(owner: OwnerDescriptor, jobId: string, discard: boolean): Promise<DeleteResult> {
    const query = discard ? '?discard_changes=1' : '';
    return this.request<DeleteResult>(
      owner,
      'DELETE',
      `/v1/jobs/${encodeURIComponent(jobId)}${query}`,
    );
  }

  steer(
    owner: OwnerDescriptor,
    jobId: string,
    message: string,
    timeoutS?: number,
  ): Promise<SteerResult> {
    const body: { message: string; timeout_s?: number } = { message };
    if (timeoutS !== undefined) body.timeout_s = timeoutS;
    return this.request<SteerResult>(
      owner,
      'POST',
      `/v1/jobs/${encodeURIComponent(jobId)}/steer`,
      body,
    );
  }

  private async probeHealth(owner: OwnerDescriptor): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${baseUrlOf(owner)}/v1/health`, {
        method: 'GET',
        headers: this.headers(owner),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.text().catch(() => '');
        return false;
      }
      const text = await response.text().catch(() => '');
      const body = parseJson(text);
      return !(isRecord(body) && body.ok === false);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(owner: OwnerDescriptor): Record<string, string> {
    return {
      authorization: `Bearer ${owner.control.token}`,
      accept: 'application/json',
    };
  }

  private async request<T>(
    owner: OwnerDescriptor,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = this.headers(owner);
    const init: RequestInit = { method, headers, redirect: 'error' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrlOf(owner)}${path}`, init);
    } catch (cause) {
      throw new ControlRequestError(0, 'network_error', messageOf(cause));
    }

    const text = await response.text().catch(() => '');
    const payload = parseJson(text);
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {};
      const code = stringOf(record.error) ?? 'http_error';
      const message = stringOf(record.message) ?? `HTTP ${response.status}`;
      const worktree = stringOf(record.worktree);
      throw new ControlRequestError(response.status, code, message, worktree);
    }
    if (payload === undefined) return {} as T;
    return payload as T;
  }
}

const sharedClient = new ControlClient();

/** Convenience wrappers for callers that do not need a state-dir client. */
export function health(owner: OwnerDescriptor): Promise<boolean> {
  return sharedClient.health(owner);
}

export function listJobs(owner: OwnerDescriptor): Promise<JobView[]> {
  return sharedClient.listJobs(owner);
}

export function cancel(owner: OwnerDescriptor, jobId: string): Promise<CancelResult> {
  return sharedClient.cancel(owner, jobId);
}

export function cleanup(
  owner: OwnerDescriptor,
  jobId: string,
  discard: boolean,
): Promise<CleanupResult> {
  return sharedClient.cleanup(owner, jobId, discard);
}

export function remove(
  owner: OwnerDescriptor,
  jobId: string,
  discard: boolean,
): Promise<DeleteResult> {
  return sharedClient.remove(owner, jobId, discard);
}

export function steer(
  owner: OwnerDescriptor,
  jobId: string,
  message: string,
  timeoutS?: number,
): Promise<SteerResult> {
  return sharedClient.steer(owner, jobId, message, timeoutS);
}

export function resetHealthBackoff(): void {
  sharedClient.resetHealthBackoff();
}

/** Alias for the typed error exposed by the client. */
export { ControlRequestError as ControlError };
