import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PanelDescriptor, PanelRuntime, SceneDescriptor, SceneRuntime } from './dsh-types.js';
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

test('registers the steer scene once and disposes both registrations together', () => {
  let panel: PanelDescriptor | undefined;
  let scene: SceneDescriptor | undefined;
  let sceneRegistrations = 0;
  let disposedPanel = false;
  let disposedScene = false;
  let cleanup: (() => void) | undefined;

  const panels: PanelRuntime = {
    register(candidate) {
      panel = candidate;
      return () => {
        disposedPanel = true;
      };
    },
  };
  const scenes: SceneRuntime = {
    register(candidate) {
      sceneRegistrations += 1;
      scene = candidate;
      return () => {
        disposedScene = true;
      };
    },
    open(id) {
      return id === 'agent-workers-steer';
    },
  };
  const ctx = {
    get: (name: string) =>
      name === 'tuiPanels' ? panels : name === 'tuiScenes' ? scenes : undefined,
    inject: (_names: string[], callback: (scoped: unknown) => void) => callback(ctx),
    effect: (callback: () => unknown) => {
      const result = callback();
      if (typeof result === 'function') cleanup = result as () => void;
    },
  };

  apply(ctx as Parameters<typeof apply>[0], { stateDir: FIXTURE });
  assert.ok(panel);
  assert.ok(scene);
  assert.equal(scene.id, 'agent-workers-steer');
  assert.equal(scene.title, 'Steer worker');
  assert.equal(typeof scene.component, 'function');
  assert.equal(sceneRegistrations, 1);

  assert.equal(typeof cleanup, 'function');
  cleanup?.();
  assert.equal(disposedScene, true);
  assert.equal(disposedPanel, true);
});
