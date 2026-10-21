import { ActionConfirmation, type ActionKind, type PendingAction } from './actions.js';
import {
  ControlClient,
  isControlRequestError,
  type JobCapabilities,
  type JobView,
  type OwnerDescriptor,
} from './control-client.js';
import type { ControlState, JobControlView } from './model.js';
import { sanitizeText } from './sanitize.js';
import { isActiveStatus, StateReader, type WorkerJob } from './state-reader.js';

export const ACTIVE_POLL_MS = 1000;
export const IDLE_POLL_MS = 4000;
export const CONTROL_POLL_MS = 5000;

export interface ActionNotice {
  readonly jobId: string;
  readonly text: string;
}

export interface StoreSnapshot {
  readonly stateDir: string;
  readonly jobs: readonly WorkerJob[];
  readonly selectedId?: string;
  readonly showAll: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly active: number;
  readonly updatedAt: number;
  readonly control: ControlState;
  readonly jobControls: ReadonlyMap<string, JobControlView>;
  readonly pending: PendingAction | null;
  readonly needsDiscard: ReadonlyMap<string, ActionKind>;
  readonly busy: ReadonlySet<string>;
  readonly actionErrors: ReadonlyMap<string, string>;
  readonly notice: ActionNotice | null;
}

export interface StoreOptions {
  pollMs?: number;
  idleMs?: number;
  controlPollMs?: number;
  reader?: StateReader;
  controlClient?: ControlClient;
  now?: () => number;
  confirmTimeoutMs?: number;
}

type Availability =
  | { readonly ok: true; readonly ownerId: string; readonly owner: OwnerDescriptor }
  | { readonly ok: false; readonly reason: string };

interface ControlRun {
  readonly owner: OwnerDescriptor;
  readonly ok: boolean;
  readonly jobs: JobView[];
}

function addToSet<T>(source: ReadonlySet<T>, value: T, add: boolean): Set<T> {
  const next = new Set(source);
  if (add) next.add(value);
  else next.delete(value);
  return next;
}

function addToMap<K, V>(source: ReadonlyMap<K, V>, key: K, value: V | undefined): Map<K, V> {
  const next = new Map(source);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

function errorText(cause: unknown): string {
  if (isControlRequestError(cause)) {
    const detail = sanitizeText(cause.message) || 'request failed';
    return `${cause.code}: ${detail}`;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return sanitizeText(detail) || 'action failed';
}

/**
 * Owns filesystem and control-plane polling. The panel only subscribes to
 * snapshots, so no read, timer or network call happens inside render.
 */
export class WorkersStore {
  private readonly reader: StateReader;
  private readonly client: ControlClient;
  private readonly listeners = new Set<() => void>();
  private readonly pollMs: number;
  private readonly idleMs: number;
  private readonly controlPollMs: number;
  private readonly now: () => number;
  private readonly confirmations: ActionConfirmation;
  private snapshot: StoreSnapshot;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controlTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private controlRunning: Promise<void> | undefined;
  private controlQueued = false;
  private lastControlAt = 0;
  private ownersById = new Map<string, OwnerDescriptor>();
  private again = false;
  private started = false;
  private visible = false;
  private disposed = false;

  constructor(stateDir: string, options: StoreOptions = {}) {
    this.reader = options.reader ?? new StateReader(stateDir);
    this.client = options.controlClient ?? new ControlClient(stateDir);
    this.pollMs = options.pollMs ?? ACTIVE_POLL_MS;
    this.idleMs = options.idleMs ?? IDLE_POLL_MS;
    this.controlPollMs = options.controlPollMs ?? CONTROL_POLL_MS;
    this.now = options.now ?? Date.now;
    this.confirmations = new ActionConfirmation(options.confirmTimeoutMs, this.now);
    this.snapshot = {
      stateDir,
      jobs: [],
      showAll: false,
      loaded: false,
      error: null,
      active: 0,
      updatedAt: 0,
      control: 'offline',
      jobControls: new Map(),
      pending: null,
      needsDiscard: new Map(),
      busy: new Set(),
      actionErrors: new Map(),
      notice: null,
    };
  }

  getSnapshot(): StoreSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.trigger();
    this.armControl(0);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) return;
    this.visible = visible;
    if (!this.started) return;
    if (visible) {
      this.trigger();
    } else {
      this.arm(this.nextDelay());
    }
  }

  setSelected(selectedId: string | undefined): void {
    if (this.snapshot.selectedId === selectedId || this.disposed) return;
    this.patch({ selectedId });
    if (this.started) this.trigger();
  }

  setShowAll(showAll: boolean): void {
    if (this.snapshot.showAll === showAll || this.disposed) return;
    this.patch({ showAll });
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.clearTimer();
    this.running = this.read().finally(() => {
      this.running = undefined;
      if (this.disposed) return;
      if (this.again) {
        this.again = false;
        void this.refresh();
      } else {
        this.arm(this.nextDelay());
      }
    });
    return this.running;
  }

  /**
   * Discover live owners and fetch their job views. Runs every five seconds
   * while the store is started; `force` bypasses the interval (used right after
   * an action).
   */
  async refreshControl(force = false): Promise<void> {
    if (this.disposed) return;
    if (
      !force &&
      this.controlRunning === undefined &&
      this.lastControlAt !== 0 &&
      this.now() - this.lastControlAt < this.controlPollMs
    ) {
      return;
    }
    while (this.controlRunning !== undefined) {
      this.controlQueued = true;
      await this.controlRunning;
    }
    this.lastControlAt = this.now();
    const run = this.readControl();
    this.controlRunning = run;
    try {
      await run;
    } finally {
      if (this.controlRunning === run) this.controlRunning = undefined;
    }
    if (this.controlQueued) {
      this.controlQueued = false;
      await this.refreshControl(true);
    }
  }

  /**
   * One key press. The first arms the action for five seconds; the second
   * matching press calls `requestAction`. Direct callers can use
   * `requestAction` after doing their own confirmation.
   */
  async pressAction(jobId: string, action: ActionKind): Promise<void> {
    if (this.disposed) return;
    const availability = this.availability(jobId, action);
    if (!availability.ok) {
      this.confirmations.disarm();
      this.clearConfirmTimer();
      this.patch({
        pending: null,
        notice: { jobId, text: `${action} unavailable: ${availability.reason}` },
      });
      return;
    }

    const stage = this.snapshot.needsDiscard.get(jobId) === action ? 'discard' : 'confirm';
    const decision = this.confirmations.press(jobId, action, stage);
    if (decision.kind === 'armed') {
      this.patch({ pending: decision.pending });
      this.armConfirmTimer();
      return;
    }
    this.clearConfirmTimer();
    if (decision.kind === 'execute') {
      this.patch({ pending: null });
      await this.requestAction(jobId, action, decision.discard);
    } else {
      this.patch({ pending: null });
    }
  }

  disarmAction(): void {
    const previous = this.confirmations.disarm();
    this.clearConfirmTimer();
    if (previous !== undefined && this.snapshot.pending !== null) {
      this.patch({ pending: null });
    }
  }

  /**
   * Route one action to the owner whose `owner_id` equals the read model's
   * `job.ownerId`. If no live owner descriptor is cached, reject locally
   * without any HTTP call.
   */
  async requestAction(jobId: string, action: ActionKind, discard = false): Promise<void> {
    if (this.disposed) return;
    const availability = this.availability(jobId, action);
    if (!availability.ok) {
      this.patch({ notice: { jobId, text: `${action} unavailable: ${availability.reason}` } });
      return;
    }
    if (this.snapshot.busy.has(jobId)) {
      this.patch({ notice: { jobId, text: 'action already running' } });
      return;
    }

    this.patch({
      busy: addToSet(this.snapshot.busy, jobId, true),
      actionErrors: addToMap(this.snapshot.actionErrors, jobId, undefined),
      notice: { jobId, text: `${action}…` },
    });

    try {
      if (action === 'cancel') {
        const result = await this.client.cancel(availability.owner, jobId);
        this.patch({
          notice: { jobId, text: `cancel sent · ${sanitizeText(result.status)}` },
        });
        this.clearDiscard(jobId);
      } else if (action === 'cleanup') {
        const result = await this.client.cleanup(availability.owner, jobId, discard);
        if (result.worktree === 'preserved_dirty') {
          this.offerDiscard(jobId, action);
        } else {
          this.patch({
            notice: { jobId, text: `cleanup · worktree ${sanitizeText(result.worktree)}` },
          });
          this.clearDiscard(jobId);
        }
      } else {
        const result = await this.client.remove(availability.owner, jobId, discard);
        this.patch({
          notice: {
            jobId,
            text: `deleted ${sanitizeText(result.job_id)} · worktree ${sanitizeText(result.worktree)}`,
          },
        });
        this.clearDiscard(jobId);
      }
      await this.refreshAfterAction();
    } catch (cause) {
      if (isControlRequestError(cause) && cause.code === 'worktree_dirty') {
        this.offerDiscard(jobId, action);
      } else {
        const text = errorText(cause);
        this.patch({
          actionErrors: addToMap(this.snapshot.actionErrors, jobId, text),
          notice: { jobId, text: `${action} failed: ${text}` },
        });
      }
    } finally {
      this.patch({ busy: addToSet(this.snapshot.busy, jobId, false) });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.clearTimer();
    this.clearControlTimer();
    this.clearConfirmTimer();
    this.listeners.clear();
  }

  private availability(jobId: string, action: ActionKind): Availability {
    const job = this.snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined) return { ok: false, reason: 'job not found' };
    const ownerId = job.ownerId;
    if (ownerId === undefined || ownerId === '') return { ok: false, reason: 'owner unknown' };
    if (this.snapshot.control === 'offline') return { ok: false, reason: 'control offline' };
    const owner = this.ownersById.get(ownerId);
    if (owner === undefined) return { ok: false, reason: 'owner offline' };
    const control = this.snapshot.jobControls.get(jobId);
    if (control === undefined) return { ok: false, reason: 'owner offline' };
    if (control.ownerId !== ownerId) return { ok: false, reason: 'owner mismatch' };
    if (control.capabilities[action] !== true) {
      return { ok: false, reason: 'not available for this job' };
    }
    if (this.snapshot.busy.has(jobId)) return { ok: false, reason: 'action already running' };
    return { ok: true, ownerId, owner };
  }

  private async readControl(): Promise<void> {
    let owners: OwnerDescriptor[] = [];
    try {
      owners = await this.client.discover();
    } catch {
      owners = [];
    }
    const results = await Promise.all(
      owners.map(async (owner): Promise<ControlRun> => {
        let live = false;
        try {
          live = await this.client.health(owner);
        } catch {
          live = false;
        }
        if (!live) return { owner, ok: false, jobs: [] };
        try {
          return { owner, ok: true, jobs: await this.client.listJobs(owner) };
        } catch {
          return { owner, ok: true, jobs: [] };
        }
      }),
    );

    const live = results.filter((result) => result.ok);
    this.ownersById = new Map(live.map((result) => [result.owner.owner_id, result.owner]));
    const jobControls = new Map<string, JobControlView>();
    for (const result of live) {
      for (const job of result.jobs) {
        jobControls.set(job.job_id, {
          ownerId: job.owner_id,
          capabilities: { ...job.capabilities },
        });
      }
    }
    const ids = new Set(jobControls.keys());
    const needsDiscard = new Map(
      [...this.snapshot.needsDiscard].filter(([jobId]) => ids.has(jobId)),
    );
    const actionErrors = new Map(
      [...this.snapshot.actionErrors].filter(([jobId]) => ids.has(jobId)),
    );
    this.patch({
      control: live.length === 0 ? 'offline' : { owners: live.length },
      jobControls,
      needsDiscard,
      actionErrors,
    });
  }

  private async refreshAfterAction(): Promise<void> {
    await this.refresh();
    await this.refreshControl(true);
    if (this.started && !this.disposed) this.armControl(this.controlPollMs);
  }

  private offerDiscard(jobId: string, action: ActionKind): void {
    this.confirmations.disarm();
    this.clearConfirmTimer();
    this.patch({
      pending: null,
      needsDiscard: addToMap(this.snapshot.needsDiscard, jobId, action),
      notice: { jobId, text: `worktree dirty · discard & ${action}?` },
    });
  }

  private clearDiscard(jobId: string): void {
    if (!this.snapshot.needsDiscard.has(jobId)) return;
    this.patch({ needsDiscard: addToMap(this.snapshot.needsDiscard, jobId, undefined) });
  }

  private async read(): Promise<void> {
    try {
      const result = await this.reader.read({ selectedId: this.snapshot.selectedId });
      if (this.disposed) return;
      const jobs = result.jobs;
      const selectedId = this.pickSelection(jobs, this.snapshot.selectedId);
      this.snapshot = {
        ...this.snapshot,
        stateDir: result.stateDir,
        jobs,
        selectedId,
        active: jobs.filter((job) => isActiveStatus(job.status)).length,
        loaded: true,
        error: null,
        updatedAt: Date.now(),
      };
      this.emit();
    } catch (cause) {
      if (this.disposed) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.snapshot = {
        ...this.snapshot,
        loaded: true,
        error: sanitizeText(message),
        updatedAt: Date.now(),
      };
      this.emit();
    }
  }

  private pickSelection(
    jobs: readonly WorkerJob[],
    current: string | undefined,
  ): string | undefined {
    if (current !== undefined && jobs.some((job) => job.id === current)) return current;
    const active = jobs.find((job) => isActiveStatus(job.status));
    return active?.id ?? jobs[0]?.id;
  }

  private nextDelay(): number {
    return this.visible || this.snapshot.active > 0 ? this.pollMs : this.idleMs;
  }

  private trigger(): void {
    this.clearTimer();
    void this.refresh();
  }

  private armConfirmTimer(): void {
    this.clearConfirmTimer();
    const pending = this.snapshot.pending;
    if (pending === null) return;
    const delay = Math.max(0, pending.expiresAtMs - this.now()) + 5;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      if (this.snapshot.pending !== pending) return;
      this.confirmations.disarm();
      this.patch({ pending: null });
    }, delay);
    this.confirmTimer.unref?.();
  }

  private armControl(delay: number): void {
    this.clearControlTimer();
    if (this.disposed || !this.started) return;
    this.controlTimer = setTimeout(() => {
      this.controlTimer = undefined;
      void this.refreshControl().finally(() => this.armControl(this.controlPollMs));
    }, delay);
    this.controlTimer.unref?.();
  }

  private arm(delay: number): void {
    this.clearTimer();
    if (this.disposed || !this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private clearControlTimer(): void {
    if (this.controlTimer !== undefined) {
      clearTimeout(this.controlTimer);
      this.controlTimer = undefined;
    }
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== undefined) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = undefined;
    }
  }

  private patch(patch: Partial<StoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A panel subscriber must not be able to stop the store.
      }
    }
  }
}

export type { JobCapabilities };
