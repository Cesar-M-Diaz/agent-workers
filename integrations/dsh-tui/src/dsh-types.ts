/**
 * Minimal, dependency-free typings for the dsh-tui panel API v1 surface this
 * package uses. The host passes its own React and UI kit through props, so the
 * plugin never imports dsh-tui or React at runtime.
 */

export type DshNode = unknown;

export type DshComponent = (props: Record<string, unknown>) => DshNode;

export interface DshReact {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: readonly unknown[]
  ): DshNode;
  useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors React.EffectCallback
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
}

export interface DshUi {
  readonly Box: DshComponent;
  readonly Text: DshComponent;
  readonly ScrollBox: DshComponent;
  readonly useAnimationTime: (intervalMs: number | null) => number;
}

export interface DshKeyFlags {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly return_?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly shift?: boolean;
  readonly isPasted?: boolean;
}

export interface DshKeyEvent {
  readonly input: string;
  readonly key: DshKeyFlags;
  preventDefault(): void;
}

export interface DshStorage {
  get(input: { key: string }): Promise<{ value: unknown | null }>;
  set(input: { key: string; value: unknown }): Promise<{ stored: true }>;
  delete(input: { key: string }): Promise<{ deleted: boolean }>;
}

export interface DshSnapshot {
  readonly cwd: string;
  readonly sessionId: string;
}

export interface DshHost {
  snapshot(): DshSnapshot;
  readonly focused: boolean;
  notify(level: 'info' | 'warning' | 'error', unread?: number): void;
  clearBadge(): void;
  toast(text: string): boolean;
  readonly storage: DshStorage | undefined;
  onKey(listener: (event: DshKeyEvent) => void): () => void;
  focus(): boolean;
  /** Open a full-screen scene registered by this plugin; false when absent. */
  openScene?(id: string): boolean;
}

export interface PanelProps {
  readonly React: DshReact;
  readonly ui: DshUi;
  readonly host: DshHost;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly mode: 'split' | 'zoom' | 'fullscreen';
}

export interface PanelDescriptor {
  readonly apiVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly minColumns?: number;
  readonly order?: number;
  readonly component: (props: PanelProps) => DshNode;
}

export interface PanelRuntime {
  register(descriptor: PanelDescriptor, identity?: unknown): (() => void) | undefined;
}

/** Key flags delivered by the scene UI kit's `useInput` (Ink names). */
export interface SceneKeyFlags {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly shift?: boolean;
  readonly isPasted?: boolean;
}

/** The subset of the scene UI kit this plugin uses. */
export interface SceneUi {
  readonly Box: DshComponent;
  readonly Text: DshComponent;
  useInput(
    handler: (input: string, key: SceneKeyFlags) => void,
    options?: { readonly isActive?: boolean },
  ): void;
  useTerminalSize(): { readonly columns: number; readonly rows: number };
}

/** Props passed to a full-screen scene registered through `ctx.tuiScenes`. */
export interface SceneProps {
  readonly React: DshReact;
  readonly ui: SceneUi;
  close(): void;
}

export interface SceneDescriptor {
  readonly id: string;
  readonly title?: string;
  readonly component: (props: SceneProps) => unknown;
}

export interface SceneRuntime {
  register(descriptor: SceneDescriptor, identity?: unknown): (() => void) | undefined;
  open(id: string): boolean;
}

/** The subset of `ctx.tuiDialogs` this plugin uses for the fallback. */
export interface DialogRuntime {
  input(request: {
    readonly title: string;
    readonly placeholder?: string;
    readonly initial?: string;
    readonly timeoutMs?: number;
  }): Promise<string | undefined>;
  confirm(request: {
    readonly title: string;
    readonly message?: string;
    readonly confirmLabel?: string;
    readonly cancelLabel?: string;
    readonly timeoutMs?: number;
  }): Promise<boolean>;
}
