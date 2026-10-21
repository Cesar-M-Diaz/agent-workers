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
  readonly return_?: boolean;
  readonly escape?: boolean;
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
