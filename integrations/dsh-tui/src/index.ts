import type { DialogRuntime, PanelRuntime, SceneRuntime } from './dsh-types.js';
import { createWorkerPanel, DIALOG_INPUT_LIMIT, type SteerUi } from './panel.js';
import { displayWidth, sanitizeText } from './sanitize.js';
import { resolveStateDir } from './state-dir.js';
import { createSteerScene } from './steer-scene.js';
import { WorkersStore } from './store.js';

export const name = 'dsh-tui-agent-workers';

export interface AgentWorkersConfig {
  /** Explicit agent-workers state directory; overrides every environment source. */
  stateDir?: string;
}

interface PluginContextLike {
  readonly logger?: { warn?: (message: string) => void };
  get?(name: string, strict?: boolean): unknown;
  inject?(names: string[], callback: (scoped: PluginContextLike) => void): void;
  effect?(callback: () => void): void;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function serviceOf<T>(candidate: PluginContextLike | undefined, name: string): T | undefined {
  try {
    if (candidate === undefined) return undefined;
    // Cordis exposes services as context properties; `get(name, false)` is the
    // optional lookup used by the existing panel code. Accept both shapes.
    const direct = (candidate as unknown as Record<string, unknown>)[name];
    if (typeof direct === 'object' && direct !== null) return direct as T;
    if (typeof candidate.get !== 'function') return undefined;
    const service = candidate.get(name, false);
    return typeof service === 'object' && service !== null ? (service as T) : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx: PluginContextLike, config: AgentWorkersConfig = {}): void {
  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    const line = `[dsh-tui-agent-workers] ${message}`;
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line);
      else console.warn(line);
    } catch {
      // Logging must never prevent activation.
    }
  };

  const panelsOf = (candidate: PluginContextLike): PanelRuntime | undefined =>
    serviceOf<PanelRuntime>(candidate, 'tuiPanels');
  const scenesOf = (candidate: PluginContextLike): SceneRuntime | undefined =>
    serviceOf<SceneRuntime>(candidate, 'tuiScenes');
  const dialogsOf = (candidate: PluginContextLike): DialogRuntime | undefined =>
    serviceOf<DialogRuntime>(candidate, 'tuiDialogs');

  let registered = false;
  const storeRef: { current: WorkersStore | undefined } = { current: undefined };
  let scenes: SceneRuntime | undefined;
  let sceneRegistered = false;
  let disposeScene: (() => void) | undefined;

  /** Register the steer scene once the panel (and therefore the store) exists. */
  const registerScene = (identity: PluginContextLike): void => {
    if (sceneRegistered) return;
    const store = storeRef.current;
    if (store === undefined) return;
    const runtime = scenes ?? scenesOf(ctx);
    if (runtime === undefined) return;
    let dispose: (() => void) | undefined;
    try {
      dispose = runtime.register(
        {
          id: 'agent-workers-steer',
          title: 'Steer worker',
          component: createSteerScene(store),
        },
        identity,
      );
    } catch (cause) {
      warnOnce(`steer scene registration failed: ${messageOf(cause)}`);
      return;
    }
    if (typeof dispose !== 'function') return;
    scenes = runtime;
    sceneRegistered = true;
    disposeScene = dispose;
  };

  const steerUi: SteerUi = {
    openScene: () => {
      try {
        return scenes?.open('agent-workers-steer') === true;
      } catch {
        return false;
      }
    },
    inputAvailable: () => {
      const dialogs = dialogsOf(ctx);
      return dialogs !== undefined && typeof dialogs.input === 'function';
    },
    prompt: async (jobId, label) => {
      const dialogs = dialogsOf(ctx);
      if (dialogs === undefined) return undefined;
      const title = sanitizeText(`Steer ${label}`) || `Steer ${jobId}`;
      const message = await dialogs.input({
        title: `${title} — cancels first; max ${DIALOG_INPUT_LIMIT} cells`,
        placeholder: 'instruction for the resumed job',
        timeoutMs: 120_000,
      });
      if (message === undefined) return undefined;
      // Never truncate: the panel refuses anything the dialog somehow returns
      // above the documented limit instead of sending a partial instruction.
      if (displayWidth(message) > DIALOG_INPUT_LIMIT || message.length === 0) return message;
      if (typeof dialogs.confirm !== 'function') return message;
      const confirmed = await dialogs.confirm({
        title: `Steer ${sanitizeText(jobId) || 'job'}?`,
        message:
          'steer cancels the job first; if resuming fails the original stays cancelled. Continue?',
        confirmLabel: 'Steer',
        cancelLabel: 'Cancel',
        timeoutMs: 60_000,
      });
      return confirmed ? message : undefined;
    },
  };

  const register = (panels: PanelRuntime, identity: PluginContextLike): void => {
    if (registered) return;
    registered = true;
    const store = new WorkersStore(resolveStateDir({ stateDir: config.stateDir }));
    storeRef.current = store;
    store.start();

    let disposePanel: (() => void) | undefined;
    try {
      disposePanel = panels.register(
        {
          apiVersion: 1,
          id: 'workers',
          title: 'Agent Workers',
          icon: 'W',
          minColumns: 28,
          order: 50,
          component: createWorkerPanel(store, steerUi),
        },
        identity,
      );
    } catch (cause) {
      store.dispose();
      storeRef.current = undefined;
      warnOnce(`panel registration failed: ${messageOf(cause)}`);
      return;
    }

    if (typeof disposePanel !== 'function') {
      store.dispose();
      storeRef.current = undefined;
      warnOnce('panel registration was rejected by the host');
      return;
    }

    registerScene(identity);

    const cleanup = (): void => {
      try {
        disposeScene?.();
      } finally {
        disposeScene = undefined;
        sceneRegistered = false;
        try {
          disposePanel?.();
        } finally {
          storeRef.current?.dispose();
          storeRef.current = undefined;
        }
      }
    };
    if (typeof identity.effect === 'function') identity.effect(() => cleanup);
    else if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
  };

  // The scene seam is injected independently: panel activation must not wait
  // for it, and a profile without tuiScenes still gets the dialog fallback.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tuiScenes'], (scoped) => {
        scenes = scenesOf(scoped) ?? scenesOf(ctx);
        if (scenes !== undefined) registerScene(scoped);
      });
    } catch {
      // Feature detection is best-effort; the panel reports the missing seam.
    }
  }

  const immediate = panelsOf(ctx);
  if (immediate !== undefined) {
    register(immediate, ctx);
    return;
  }

  if (typeof ctx.inject !== 'function') {
    warnOnce('tuiPanels service is not available; panel not registered');
    return;
  }

  ctx.inject(['tuiPanels'], (scoped) => {
    const panels = panelsOf(scoped) ?? panelsOf(ctx);
    if (panels === undefined) {
      warnOnce('tuiPanels service is not available; panel not registered');
      return;
    }
    register(panels, scoped);
  });
}
