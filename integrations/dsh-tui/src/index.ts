import type { PanelRuntime } from './dsh-types.js';
import { createWorkerPanel } from './panel.js';
import { resolveStateDir } from './state-dir.js';
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

  const panelsOf = (candidate: PluginContextLike): PanelRuntime | undefined => {
    try {
      if (typeof candidate.get !== 'function') return undefined;
      const service = candidate.get('tuiPanels', false);
      return typeof service === 'object' && service !== null
        ? (service as PanelRuntime)
        : undefined;
    } catch {
      return undefined;
    }
  };

  let registered = false;
  const storeRef: { current: WorkersStore | undefined } = { current: undefined };

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
          component: createWorkerPanel(store),
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

    const cleanup = (): void => {
      try {
        disposePanel?.();
      } finally {
        storeRef.current?.dispose();
        storeRef.current = undefined;
      }
    };
    if (typeof identity.effect === 'function') identity.effect(() => cleanup);
    else if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
  };

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
