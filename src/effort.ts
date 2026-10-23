import { JobError } from './errors.js';

/** Levels accepted by the worker CLI adapters; never silently clamp a request. */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function validateEffort(value: unknown): Effort {
  if (typeof value !== 'string' || !EFFORT_LEVELS.includes(value as Effort)) {
    throw new JobError(
      'invalid_effort',
      `invalid effort ${String(value)}; expected ${EFFORT_LEVELS.join(', ')}`,
    );
  }
  return value as Effort;
}
