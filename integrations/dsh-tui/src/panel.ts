import type { DshHost, DshKeyEvent, DshStorage, PanelProps } from './dsh-types.js';
import { buildModel, type WorkersModel } from './model.js';
import { displayWidth, fitText } from './sanitize.js';
import type { StoreSnapshot, WorkersStore } from './store.js';

const SELECTED_KEY = 'selectedId';
const SHOW_ALL_KEY = 'showAll';

/** `ctx.tuiDialogs.input` resolves at most 500 cells; longer text is refused. */
export const DIALOG_INPUT_LIMIT = 500;

/**
 * Host-side hooks the panel needs to open the steer editor. They are closures
 * because `tuiScenes`/`tuiDialogs` may mount after the panel is registered.
 */
export interface SteerUi {
  openScene(): boolean;
  inputAvailable(): boolean;
  prompt(jobId: string, label: string): Promise<string | undefined>;
}

function storageOf(host: DshHost): DshStorage | undefined {
  try {
    return host.storage;
  } catch {
    return undefined;
  }
}

function cwdOf(host: DshHost): string | undefined {
  try {
    const cwd = host.snapshot().cwd;
    return typeof cwd === 'string' ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function moveSelection(store: WorkersStore, rows: readonly { id: string }[], delta: number): void {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  const current = store.getSnapshot().selectedId;
  const index = current === undefined ? -1 : ids.indexOf(current);
  const next =
    index < 0
      ? delta > 0
        ? 0
        : ids.length - 1
      : Math.min(ids.length - 1, Math.max(0, index + delta));
  const id = ids[next];
  if (id !== undefined) store.setSelected(id);
}

export function createWorkerPanel(
  store: WorkersStore,
  steerUi?: SteerUi,
): (props: PanelProps) => unknown {
  return function AgentWorkersPanel(props: PanelProps): unknown {
    const { React, ui, host, width, height, focused, visible } = props;
    const [snapshot, setSnapshot] = React.useState<StoreSnapshot>(() => store.getSnapshot());
    const [expanded, setExpanded] = React.useState(false);
    const [persistReady, setPersistReady] = React.useState(false);
    const persistStarted = React.useRef(false);
    const view = React.useRef<WorkersModel | null>(null);
    const storage = storageOf(host);

    React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);

    React.useEffect(() => {
      store.setVisible(visible);
      return () => {
        if (visible) store.setVisible(false);
      };
    }, [store, visible]);

    React.useEffect(() => {
      if (storage === undefined || persistStarted.current) return;
      persistStarted.current = true;
      let alive = true;
      const load = async (): Promise<void> => {
        try {
          const [selected, all] = await Promise.all([
            storage.get({ key: SELECTED_KEY }),
            storage.get({ key: SHOW_ALL_KEY }),
          ]);
          if (!alive) return;
          if (typeof selected.value === 'string' && selected.value !== '') {
            store.setSelected(selected.value);
          }
          if (typeof all.value === 'boolean') store.setShowAll(all.value);
        } catch {
          // Storage is optional; the panel keeps working without persistence.
        } finally {
          if (alive) setPersistReady(true);
        }
      };
      void load();
      return () => {
        alive = false;
      };
    }, [storage, store]);

    React.useEffect(() => {
      if (storage === undefined || !persistReady) return;
      void storage
        .set({ key: SELECTED_KEY, value: snapshot.selectedId ?? null })
        .catch(() => undefined);
    }, [storage, persistReady, snapshot.selectedId]);

    React.useEffect(() => {
      if (storage === undefined || !persistReady) return;
      void storage.set({ key: SHOW_ALL_KEY, value: snapshot.showAll }).catch(() => undefined);
    }, [storage, persistReady, snapshot.showAll]);

    const knownFailed = React.useRef<Set<string> | null>(null);
    React.useEffect(() => {
      const failed = new Set(
        snapshot.jobs.filter((job) => job.status === 'failed').map((job) => job.id),
      );
      const previous = knownFailed.current;
      knownFailed.current = failed;
      if (previous === null) return;
      const fresh = [...failed].filter((id) => !previous.has(id)).length;
      if (fresh === 0) return;
      try {
        host.notify('error', fresh);
      } catch {
        // Badge errors must never break the panel.
      }
    }, [snapshot.jobs, host]);

    React.useEffect(() => {
      if (!focused) return;
      try {
        host.clearBadge();
      } catch {
        // Badge errors must never break the panel.
      }
    }, [focused, host]);

    const model = buildModel(snapshot.jobs, {
      width,
      selectedId: snapshot.selectedId,
      showAll: snapshot.showAll,
      cwd: cwdOf(host),
      error: snapshot.error,
      control: {
        state: snapshot.control,
        jobs: snapshot.jobControls,
        pending: snapshot.pending,
        needsDiscard: snapshot.needsDiscard,
        busy: snapshot.busy,
        message: snapshot.notice?.text ?? null,
        errors: snapshot.actionErrors,
      },
    });
    view.current = model;

    const fallbackSteer = async (jobId: string, label: string): Promise<void> => {
      if (steerUi === undefined) return;
      try {
        const message = await steerUi.prompt(jobId, label);
        if (message === undefined) return;
        if (message.length === 0) {
          store.reportSteerUnavailable(jobId, 'message is empty');
          return;
        }
        const cells = displayWidth(message);
        if (cells > DIALOG_INPUT_LIMIT) {
          store.reportSteerUnavailable(
            jobId,
            `input dialog is limited to ${DIALOG_INPUT_LIMIT} cells (got ${cells}); use the full-screen editor`,
          );
          return;
        }
        await store.requestSteer(jobId, message);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        store.reportSteerUnavailable(jobId, detail);
      }
    };

    React.useEffect(() => {
      const dispose = host.onKey((event: DshKeyEvent) => {
        if (!focused) return;
        const key = event.key;
        const input = event.input;
        const rows = view.current?.rows ?? [];

        if (key.upArrow === true || input === 'k') {
          store.disarmAction();
          moveSelection(store, rows, -1);
          event.preventDefault();
          return;
        }
        if (key.downArrow === true || input === 'j') {
          store.disarmAction();
          moveSelection(store, rows, 1);
          event.preventDefault();
          return;
        }
        if (key.return_ === true || input === '\r' || input === '\n') {
          store.disarmAction();
          setExpanded((value) => !value);
          event.preventDefault();
          return;
        }
        if (key.escape === true) {
          store.disarmAction();
          event.preventDefault();
          return;
        }
        if (input === 'r') {
          store.disarmAction();
          void store.refresh();
          event.preventDefault();
          return;
        }
        if (input === 'a') {
          store.disarmAction();
          store.setShowAll(!store.getSnapshot().showAll);
          event.preventDefault();
          return;
        }
        if (input === 's') {
          store.disarmAction();
          event.preventDefault();
          const current = store.getSnapshot();
          const selectedId = current.selectedId;
          if (selectedId === undefined) {
            store.reportSteerUnavailable('', 'no job selected');
            return;
          }
          const job = current.jobs.find((candidate) => candidate.id === selectedId);
          if (!store.prepareSteer(selectedId)) return;

          let opened = false;
          try {
            opened = steerUi?.openScene() === true;
          } catch {
            opened = false;
          }
          if (opened) return;
          store.clearSteerTarget();
          if (steerUi?.inputAvailable() === true) {
            void fallbackSteer(selectedId, job?.label ?? selectedId);
            return;
          }
          store.reportSteerUnavailable(
            selectedId,
            'no full-screen scene or input dialog available',
          );
          return;
        }
        const action =
          input === 'c'
            ? 'cancel'
            : input === 'x'
              ? 'cleanup'
              : input === 'd'
                ? 'delete'
                : undefined;
        if (action !== undefined) {
          const selectedId = store.getSnapshot().selectedId;
          if (selectedId === undefined) store.disarmAction();
          else void store.pressAction(selectedId, action);
          event.preventDefault();
          return;
        }
        store.disarmAction();
      });
      return dispose;
    }, [host, store, focused, steerUi]);

    const headerLines = [...model.header, model.banner];
    if (model.error !== undefined) headerLines.push(model.error);

    const body: string[] = [];
    if (!snapshot.loaded) {
      body.push(fitText('loading…', width));
    } else if (model.empty) {
      body.push(fitText('no jobs', width));
    } else {
      for (const group of model.groups) {
        body.push(
          fitText(`${group.active ? '▾' : '▸'} ${group.name} · ${group.rows.length}`, width),
        );
        for (const row of group.rows) body.push(...row.lines);
      }
    }
    if (expanded && model.detail !== undefined) {
      body.push('');
      body.push(...model.detail.lines);
    }

    const footer = model.footer;
    const bodyHeight = Math.max(1, Math.floor(height) - headerLines.length - 1);

    return React.createElement(
      ui.Box,
      { flexDirection: 'column', width, height, overflow: 'hidden' },
      ...headerLines.map((line, index) =>
        React.createElement(
          ui.Text,
          { key: `header-${index}`, bold: index === 0, dimColor: index > 0 },
          line,
        ),
      ),
      React.createElement(
        ui.ScrollBox,
        { key: 'body', flexDirection: 'column', flexGrow: 1, height: bodyHeight },
        ...body.map((line, index) => React.createElement(ui.Text, { key: `body-${index}` }, line)),
      ),
      React.createElement(ui.Text, { key: 'footer', dimColor: true }, footer),
    );
  };
}
