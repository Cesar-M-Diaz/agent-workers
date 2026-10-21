/**
 * Full-screen steer editor scene.
 *
 * The host registers this component once; the panel selects the target job in
 * the shared store and calls `host.openScene('agent-workers-steer')`. Everything React
 * related comes from `props` (single-React rule): this module never imports
 * React or the UI kit at runtime.
 */

import type { SceneKeyFlags, SceneProps } from './dsh-types.js';
import { fitText, sanitizeText } from './sanitize.js';
import { isActiveStatus } from './state-reader.js';
import { MAX_STEER_CHARS, SteerEditor } from './steer-editor.js';
import type { WorkersStore } from './store.js';

export const STEER_ACTIVE_WARNING = [
  'warning: steer cancels this running job first;',
  'if resuming fails it stays cancelled',
] as const;

export function steerWarningLines(active: boolean): string[] {
  return active ? [...STEER_ACTIVE_WARNING] : [];
}

export function steerStatusLine(length: number, suffix?: string): string {
  const count = `${length}/${MAX_STEER_CHARS}`;
  return suffix === undefined || suffix === '' ? count : `${count} · ${suffix}`;
}

/**
 * Two Ctrl+S presses within five seconds, with the same clock/window semantics
 * as the panel's ActionConfirmation. Any other key calls `disarm()`.
 */
export class SteerSubmitGate {
  private armedAt: number | undefined;

  constructor(
    private readonly timeoutMs = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  press(): 'armed' | 'submit' {
    const now = this.now();
    if (this.armedAt !== undefined && now - this.armedAt <= this.timeoutMs) {
      this.armedAt = undefined;
      return 'submit';
    }
    this.armedAt = now;
    return 'armed';
  }

  disarm(): void {
    this.armedAt = undefined;
  }

  isArmed(): boolean {
    if (this.armedAt === undefined) return false;
    if (this.now() - this.armedAt > this.timeoutMs) {
      this.armedAt = undefined;
      return false;
    }
    return true;
  }
}

interface Status {
  readonly text: string;
  readonly tone: 'info' | 'warn' | 'error' | 'success';
}

export function createSteerScene(store: WorkersStore): (props: SceneProps) => unknown {
  return function SteerScene(props: SceneProps): unknown {
    const { React, ui, close } = props;
    const h = React.createElement;
    const editor = React.useRef<SteerEditor | null>(null);
    if (editor.current === null) editor.current = new SteerEditor();
    const target = React.useRef<string | undefined>(store.getSteerTarget());
    const gate = React.useRef<SteerSubmitGate | null>(null);
    if (gate.current === null) gate.current = new SteerSubmitGate();

    const [, setVersion] = React.useState(0);
    const [status, setStatus] = React.useState<Status>({
      text: steerStatusLine(0, 'Ctrl+S submit · Esc cancel'),
      tone: 'info',
    });
    const [sending, setSending] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    const [done, setDone] = React.useState<string | undefined>(undefined);
    const alive = React.useRef(true);
    const buffered = editor.current;
    const submitGate = gate.current;

    React.useEffect(() => {
      alive.current = true;
      const unsubscribe = store.subscribe(() => setVersion((value) => value + 1));
      return () => {
        alive.current = false;
        unsubscribe();
      };
    }, [store]);

    React.useEffect(() => {
      if (!confirming) return;
      const timer = setTimeout(() => {
        submitGate.disarm();
        setConfirming(false);
        setStatus({ text: steerStatusLine(buffered.length, 'confirmation expired'), tone: 'info' });
      }, 5000);
      return () => clearTimeout(timer);
    }, [confirming, submitGate, buffered]);

    React.useEffect(() => {
      if (done === undefined) return;
      const timer = setTimeout(() => {
        store.clearSteerTarget();
        close();
      }, 1200);
      return () => clearTimeout(timer);
    }, [done, close, store]);

    const jobId = target.current;
    const snapshot = store.getSnapshot();
    const job = jobId === undefined ? undefined : snapshot.jobs.find((entry) => entry.id === jobId);
    const capabilities =
      jobId === undefined ? undefined : snapshot.jobControls.get(jobId)?.capabilities;
    const active = job !== undefined && isActiveStatus(job.status);
    const label = sanitizeText(job?.label ?? '') || jobId || 'none';

    const finish = (): void => {
      store.clearSteerTarget();
      close();
    };

    const submit = async (): Promise<void> => {
      if (sending) return;
      if (jobId === undefined) {
        setStatus({ text: 'no steer target selected · Esc to close', tone: 'error' });
        return;
      }
      if (buffered.length === 0) {
        setStatus({ text: 'message is empty · type an instruction first', tone: 'warn' });
        return;
      }
      submitGate.disarm();
      setConfirming(false);
      setSending(true);
      setStatus({ text: steerStatusLine(buffered.length, 'sending…'), tone: 'info' });
      const outcome = await store.requestSteer(jobId, buffered.text);
      if (!alive.current) return;
      setSending(false);
      if (outcome.ok) {
        const steeredId = sanitizeText(outcome.result.steered_job_id) || 'unknown';
        setStatus({
          text: steerStatusLine(buffered.length, `steered → ${steeredId} · closing…`),
          tone: 'success',
        });
        setDone(steeredId);
        return;
      }
      const code = sanitizeText(outcome.error.code) || 'steer_failed';
      const message = sanitizeText(outcome.error.message) || 'steer failed';
      setStatus({
        text: steerStatusLine(buffered.length, `${code}: ${message} · text kept`),
        tone: 'error',
      });
    };

    ui.useInput(
      (input: string, key: SceneKeyFlags) => {
        if (sending) return;
        if (key.escape === true) {
          finish();
          return;
        }
        if ((key.ctrl === true && (input === 's' || input === 'S')) || input === '\u0013') {
          const decision = submitGate.press();
          if (decision === 'submit') {
            void submit();
            return;
          }
          setConfirming(true);
          setStatus({
            text: steerStatusLine(buffered.length, 'press Ctrl+S again within 5 s to confirm'),
            tone: 'warn',
          });
          return;
        }

        // Any other key cancels a pending submit confirmation.
        submitGate.disarm();
        if (confirming) setConfirming(false);

        let changed = false;
        if (key.return === true) changed = buffered.newline();
        else if (key.backspace === true) changed = buffered.backspace();
        else if (key.delete === true) changed = buffered.delete();
        else if (key.leftArrow === true) changed = buffered.left();
        else if (key.rightArrow === true) changed = buffered.right();
        else if (key.upArrow === true) changed = buffered.up();
        else if (key.downArrow === true) changed = buffered.down();
        else if (key.home === true) changed = buffered.home();
        else if (key.end === true) changed = buffered.end();
        else if (input !== '' && key.ctrl !== true && key.meta !== true && key.super !== true) {
          if (!buffered.insert(input)) {
            if (buffered.atLimit) {
              setStatus({
                text: steerStatusLine(buffered.length, 'limit reached · input refused'),
                tone: 'warn',
              });
            }
          } else {
            changed = true;
          }
        }

        if (changed) {
          setStatus({
            text: steerStatusLine(buffered.length, 'Ctrl+S submit · Esc cancel'),
            tone: 'info',
          });
          setVersion((value) => value + 1);
        }
      },
      { isActive: true },
    );

    const size = ui.useTerminalSize();
    const columns = Math.max(20, Math.floor(size?.columns ?? 80));
    const rows = Math.max(10, Math.floor(size?.rows ?? 24));
    const editorWidth = Math.max(10, columns - 4);
    const unavailable = capabilities !== undefined && capabilities.steer !== true;
    const chrome = 7 + steerWarningLines(active).length + (unavailable ? 1 : 0);
    const editorHeight = Math.max(3, rows - chrome);
    const window = buffered.renderWindow(editorWidth, editorHeight);

    const header: unknown[] = [
      h(ui.Text, { key: 'title', bold: true }, ' Steer worker '),
      h(
        ui.Text,
        { key: 'job', dimColor: true },
        fitText(`job ${jobId ?? 'none'} · ${label}`, columns - 4),
      ),
    ];
    for (const [index, line] of steerWarningLines(active).entries()) {
      header.push(
        h(ui.Text, { key: `warning-${index}`, color: 'red' }, fitText(line, columns - 4)),
      );
    }
    if (unavailable) {
      header.push(
        h(
          ui.Text,
          { key: 'unavailable', color: 'red' },
          fitText('steer is not available for this job', columns - 4),
        ),
      );
    }

    const editorLines = window.lines.map((line, index) => {
      if (index !== window.cursorRow) {
        return h(ui.Text, { key: `line-${index}` }, line === '' ? ' ' : line);
      }
      const cursorIndex = Math.min(window.cursorIndex, line.length);
      const before = line.slice(0, cursorIndex);
      const cursor = line.slice(cursorIndex, cursorIndex + 1) || ' ';
      const after = line.slice(cursorIndex + 1);
      return h(
        ui.Box,
        { key: `line-${index}`, flexDirection: 'row' },
        h(ui.Text, { key: 'before' }, before),
        h(ui.Text, { key: 'cursor', inverse: true }, cursor),
        h(ui.Text, { key: 'after' }, after),
      );
    });

    const toneColor =
      status.tone === 'error'
        ? 'red'
        : status.tone === 'warn'
          ? 'yellow'
          : status.tone === 'success'
            ? 'green'
            : undefined;
    const statusProps: Record<string, unknown> = { key: 'status' };
    if (toneColor !== undefined) statusProps.color = toneColor;

    return h(
      ui.Box,
      {
        flexDirection: 'column',
        width: columns,
        height: rows,
        borderStyle: 'round',
        paddingX: 1,
        overflow: 'hidden',
      },
      ...header,
      h(ui.Box, { key: 'editor', flexDirection: 'column', height: editorHeight }, ...editorLines),
      h(ui.Text, statusProps, fitText(status.text, columns - 4)),
      h(
        ui.Text,
        { key: 'help', dimColor: true },
        fitText(
          'Ctrl+S submit · Esc cancel · Enter newline · arrows move · backspace/delete',
          columns - 4,
        ),
      ),
    );
  };
}
