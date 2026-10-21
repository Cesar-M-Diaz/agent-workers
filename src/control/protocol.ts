import type { AccessMode, Isolation, JobAlert, JobStatus, Usage } from '../types.js';

/** Limits shared by the HTTP control API and its tests. */
export const CONTROL_LIMITS = {
  maxBodyBytes: 64 * 1024,
  messageMin: 1,
  messageMax: 20_000,
  timeoutMinS: 60,
  timeoutMaxS: 3_600,
  maxCharsMin: 1_000,
  maxCharsMax: 50_000,
  limitMin: 1,
  limitMax: 500,
  requestTimeoutMs: 35_000,
} as const;

export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export const INCLUDE_OPTIONS = [
  'final',
  'diff_stat',
  'diff',
  'stderr_tail',
  'events_tail',
] as const;

export type IncludeOption = (typeof INCLUDE_OPTIONS)[number];

export interface WorktreeView {
  path: string;
  branch: string;
  base_commit: string;
  repo_root: string;
  cleaned: boolean;
}

export interface JobCapabilities {
  cancel: boolean;
  steer: boolean;
  cleanup: boolean;
  delete: boolean;
  read_result: boolean;
  read_events: boolean;
}

/** The control API representation of one job; never contains the task or env. */
export interface JobView {
  job_id: string;
  label: string | null;
  status: JobStatus;
  reason: string | null;
  backend: 'dsh' | 'pi';
  owner_id: string;
  owned: boolean;
  group_id: string;
  group_name: string;
  profile: string;
  provider: string | null;
  model: string | null;
  access: AccessMode;
  isolation: Isolation;
  cwd: string;
  worktree: WorktreeView | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  elapsed_s: number;
  queue_position: number | null;
  session_id: string | null;
  pid: number | null;
  steps: number;
  tool_calls: number;
  last_tool: string | null;
  last_event_s_ago: number | null;
  malformed_lines: number;
  events_count: number;
  usage: Usage | null;
  cost_usd: number | null;
  alerts: JobAlert[];
  resume_of: string | null;
  steered_from: string | null;
  capabilities: JobCapabilities;
}

export interface ControlHealth {
  ok: boolean;
  protocol: string;
  version: string;
  owner_id: string;
  pid: number;
  ready: boolean;
  state_dir: string;
  backend: 'dsh' | 'pi';
  max_concurrent: number;
  max_queue: number;
  running: number;
  queued: number;
}

export interface ControlJobs {
  server: ControlHealth;
  jobs: JobView[];
}

/**
 * Stable control-protocol error codes mapped to HTTP status. Any code that is
 * not listed here is an internal error, as required by the frozen contract.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  invalid_job_id: 400,
  invalid_cursor: 400,
  invalid_include: 400,
  unauthorized: 401,
  forbidden_host: 403,
  forbidden_origin: 403,
  unknown_job: 404,
  job_not_found: 404,
  not_found: 404,
  already_settled: 409,
  not_terminal: 409,
  job_active: 409,
  worktree_dirty: 409,
  worktree_busy: 409,
  session_busy: 409,
  not_owner: 409,
  resume_unavailable: 409,
  steer_timeout: 409,
  write_conflict: 409,
  pi_write_disabled: 409,
  body_too_large: 413,
  unsupported_media_type: 415,
  not_ready: 503,
  worker_unavailable: 503,
  internal_error: 500,
};

export function httpStatusFor(code: string): number {
  return ERROR_STATUS[code] ?? 500;
}

export class ControlError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    this.details = details;
  }
}
