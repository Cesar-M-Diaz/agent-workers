export type AccessMode = 'read-only' | 'workspace-write';
export type Isolation = 'worktree' | 'none';
export type JobStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted';

export type FailureReason =
  | 'spawn_error'
  | 'driver_error'
  | 'turn_error'
  | 'turn_aborted'
  | 'no_turn_end'
  | 'no_final'
  | 'empty_final'
  | 'nonzero_exit'
  | 'queue_full'
  | 'depth_exceeded'
  | 'cwd_outside_roots'
  | 'write_conflict'
  | 'resume_unavailable'
  | 'dsh_unavailable'
  | 'already_settled'
  | 'not_terminal'
  | 'worktree_error';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
  repoRoot: string;
  cleaned?: boolean;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface WorktreeChanges {
  baseCommit: string;
  files: ChangedFile[];
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
}

export interface JobSummary {
  job_id: string;
  label?: string;
  status: JobStatus;
  reason?: string;
  access: AccessMode;
  isolation: Isolation;
  cwd: string;
  worktree?: { path: string; branch: string; base_commit: string; cleaned: boolean };
  created_at: string;
  started_at?: string;
  elapsed_s?: number;
  queue_position?: number;
  session_id?: string;
  pid?: number;
  steps: number;
  tool_calls: number;
  last_tool?: string;
  last_event_s_ago?: number;
  malformed_lines: number;
  usage?: Usage;
}

export interface StartInput {
  task: string;
  label?: string;
  cwd?: string;
  access?: AccessMode;
  isolation?: Isolation;
  base_ref?: string;
  timeout_s?: number;
  resume_job_id?: string;
}

export interface StartResult {
  job_id: string;
  status: JobStatus;
  queue_position?: number;
  cwd: string;
  worktree: { path: string; branch: string; base_commit: string } | null;
}

export interface StatusOutput {
  server: {
    dsh_version: string;
    max_concurrent: number;
    max_queue: number;
    running: number;
    queued: number;
    state_dir: string;
  };
  jobs: JobSummary[];
}

export interface WaitOutput {
  jobs: JobSummary[];
  settled: string[];
  timed_out: boolean;
  wait_aborted?: boolean;
}
