import type { FoldedRun } from '../ndjson.js';
import type { AccessMode, Usage } from '../types.js';

export type EngineId = 'dsh' | 'pi';

export interface EngineLaunchSpec {
  jobId: string;
  cwd: string;
  profile: string;
  provider?: string;
  model?: string;
  /** Resolved effort; absent only when resuming a legacy job with unknown effort. */
  effort?: string;
  access: AccessMode;
  sessionId?: string;
  /** Directory owned by the job; engines may keep session files under it. */
  sessionDir: string;
  depth: number;
}

export interface EngineLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** How the task is delivered: dsh reads stdin, pi takes an argv prompt. */
  taskInput: 'stdin' | 'argv';
}

export interface Fold {
  readonly state: FoldedRun;
  push(chunk: Buffer): void;
  end(): FoldedRun;
}

export interface EngineProfileMetadata {
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface Engine {
  readonly id: EngineId;
  readonly label: string;
  readonly defaultProfile: string;
  readonly supportsResume: boolean;
  init(): Promise<{ version: string }>;
  availableProfiles(): Promise<string[]>;
  resolveProfile(name: string): Promise<string>;
  readProfileMetadata(profile: string): Promise<EngineProfileMetadata>;
  ensureReady(profile: string): Promise<void>;
  /** Optional check that a session file still exists before resuming it. */
  hasSession?(sessionDir: string, sessionId: string): Promise<boolean>;
  launch(spec: EngineLaunchSpec, task: string): Promise<EngineLaunchPlan>;
  createFold(onEvent: (line: string) => void): Fold;
}

export interface EngineSet {
  readonly dsh: Engine;
  readonly pi: Engine;
  byId(id: EngineId): Engine;
}

export type { Usage };
