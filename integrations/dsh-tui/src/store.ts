import { sanitizeText } from './sanitize.js';
import { isActiveStatus, StateReader, type WorkerJob } from './state-reader.js';

export const ACTIVE_POLL_MS = 1000;
export const IDLE_POLL_MS = 4000;

export interface StoreSnapshot {
  readonly stateDir: string;
  readonly jobs: readonly WorkerJob[];
  readonly selectedId?: string;
  readonly showAll: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly active: number;
  readonly updatedAt: number;
}

export interface StoreOptions {
  pollMs?: number;
  idleMs?: number;
  reader?: StateReader;
}

/**
 * Owns the filesystem polling. The panel only subscribes to snapshots, so no
 * read or timer runs inside render.
 */
export class WorkersStore {
  private readonly reader: StateReader;
  private readonly listeners = new Set<() => void>();
  private readonly pollMs: number;
  private readonly idleMs: number;
  private snapshot: StoreSnapshot;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private started = false;
  private visible = false;
  private disposed = false;

  constructor(stateDir: string, options: StoreOptions = {}) {
    this.reader = options.reader ?? new StateReader(stateDir);
    this.pollMs = options.pollMs ?? ACTIVE_POLL_MS;
    this.idleMs = options.idleMs ?? IDLE_POLL_MS;
    this.snapshot = {
      stateDir,
      jobs: [],
      showAll: false,
      loaded: false,
      error: null,
      active: 0,
      updatedAt: 0,
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.clearTimer();
    this.listeners.clear();
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
