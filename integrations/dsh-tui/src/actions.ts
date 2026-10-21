/**
 * Pure confirmation state machine for the panel's control actions.
 *
 * One press arms an action for five seconds; the matching key pressed again
 * inside that window executes it. Any other press (or the timeout) disarms.
 * `stage: 'discard'` is the second confirmation offered after the control API
 * reports a dirty worktree.
 */

export type ActionKind = 'cancel' | 'cleanup' | 'delete';
export type ConfirmStage = 'confirm' | 'discard';

export const CONFIRM_TIMEOUT_MS = 5000;

export interface PendingAction {
  readonly jobId: string;
  readonly action: ActionKind;
  readonly stage: ConfirmStage;
  readonly expiresAtMs: number;
}

export type ActionDecision =
  | { readonly kind: 'armed'; readonly pending: PendingAction }
  | {
      readonly kind: 'execute';
      readonly jobId: string;
      readonly action: ActionKind;
      readonly stage: ConfirmStage;
      readonly discard: boolean;
    }
  | { readonly kind: 'disarmed'; readonly previous: PendingAction };

export function actionKey(action: ActionKind): string {
  switch (action) {
    case 'cancel':
      return 'c';
    case 'cleanup':
      return 'x';
    case 'delete':
      return 'd';
  }
}

export function describePending(pending: PendingAction): string {
  return pending.stage === 'discard' ? 'confirm discard?' : `confirm ${pending.action}?`;
}

/**
 * The clock is injected so tests can prove the five-second window without
 * sleeping. The class never performs I/O.
 */
export class ActionConfirmation {
  private pending: PendingAction | undefined;

  constructor(
    private readonly timeoutMs: number = CONFIRM_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  getPending(): PendingAction | undefined {
    this.expire(this.now());
    return this.pending;
  }

  /**
   * A matching second press executes. A non-matching press disarms the pending
   * action and does not arm the new one; the caller can press again.
   */
  press(jobId: string, action: ActionKind, stage: ConfirmStage = 'confirm'): ActionDecision {
    const now = this.now();
    const pending = this.expire(now);
    if (
      pending !== undefined &&
      pending.jobId === jobId &&
      pending.action === action &&
      pending.stage === stage
    ) {
      this.pending = undefined;
      return { kind: 'execute', jobId, action, stage, discard: stage === 'discard' };
    }
    if (pending !== undefined) {
      this.pending = undefined;
      return { kind: 'disarmed', previous: pending };
    }
    const next: PendingAction = {
      jobId,
      action,
      stage,
      expiresAtMs: now + this.timeoutMs,
    };
    this.pending = next;
    return { kind: 'armed', pending: next };
  }

  disarm(): PendingAction | undefined {
    const previous = this.expire(this.now());
    this.pending = undefined;
    return previous;
  }

  private expire(now: number): PendingAction | undefined {
    if (this.pending !== undefined && now >= this.pending.expiresAtMs) {
      this.pending = undefined;
    }
    return this.pending;
  }
}

/** Alias kept explicit for callers that prefer the longer name. */
export { ActionConfirmation as ConfirmationStateMachine };
