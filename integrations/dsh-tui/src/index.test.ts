import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PanelDescriptor, PanelRuntime } from './dsh-types.js';
import { apply } from './index.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/state', import.meta.url));

test('registers the workers panel and disposes it with the activation effect', () => {
  let descriptor: PanelDescriptor | undefined;
  let disposedPanel = false;
  let cleanup: (() => void) | undefined;
  const panels: PanelRuntime = {
    register(candidate) {
      descriptor = candidate;
      return () => {
        disposedPanel = true;
      };
    },
  };
  const ctx = {
    get: (name: string) => (name === 'tuiPanels' ? panels : undefined),
    effect: (callback: () => unknown) => {
      const result = callback();
      if (typeof result === 'function') cleanup = result as () => void;
    },
  };

  apply(ctx, { stateDir: FIXTURE });
  assert.ok(descriptor);
  assert.equal(descriptor.apiVersion, 1);
  assert.equal(descriptor.id, 'workers');
  assert.equal(descriptor.title, 'Agent Workers');
  assert.equal(descriptor.minColumns, 28);
  assert.equal(typeof descriptor.component, 'function');

  assert.equal(typeof cleanup, 'function');
  cleanup?.();
  assert.equal(disposedPanel, true);
});

test('logs one warning and returns when tuiPanels is missing', () => {
  const warnings: string[] = [];
  const ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    inject: (_names: string[], callback: (scoped: { get: () => unknown }) => void) =>
      callback({ get: () => undefined }),
  };
  apply(ctx);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /tuiPanels/);
});
