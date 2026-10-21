import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  resolveApiKey,
  resolveCredential,
  resolveOpenCodeGoApiKey,
  resolveOpenRouterChatApiKey,
} from '../src/config.js';

const ENV_NAMES = ['DEEPSEEK_API_KEY', 'OPENROUTER_CHAT_API_KEY', 'OPENCODE_GO_API_KEY'] as const;
let roots: string[] = [];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of ENV_NAMES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function credentialStore(text: string): Promise<{
  useDshCredentials: boolean;
  credentialsFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-workers-config-'));
  roots.push(root);
  const credentialsFile = join(root, 'credentials.yaml');
  await writeFile(credentialsFile, text, { mode: 0o600 });
  return { useDshCredentials: true, credentialsFile };
}

describe('watchdog configuration', () => {
  const WATCHDOG_ENV = [
    'AGENT_WORKERS_STALL_S',
    'AGENT_WORKERS_LOOP_REPEAT',
    'AGENT_WORKERS_TOOL_ERROR_LIMIT',
    'AGENT_WORKERS_MAX_STEPS',
    'AGENT_WORKERS_MAX_COST_USD',
    'AGENT_WORKERS_WATCHDOG_ACTION',
    'AGENT_WORKERS_STATE_DIR',
    'AGENT_WORKERS_WORKTREE_ROOT',
    'AGENT_WORKERS_DSH_HOME',
    'AGENT_WORKERS_ALLOWED_ROOTS',
    'AGENT_WORKERS_MAX_CONCURRENT',
    'AGENT_WORKERS_BACKEND',
    'AGENT_WORKERS_CONTROL',
    'DSH_WORKERS_MAX_CONCURRENT',
    'DSH_WORKERS_BACKEND',
    'DSH_WORKERS_CONTROL',
    'XDG_STATE_HOME',
  ] as const;
  let watchdogSaved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    watchdogSaved = {};
    for (const name of WATCHDOG_ENV) {
      watchdogSaved[name] = process.env[name];
      delete process.env[name];
    }
    const root = await mkdtemp(join(tmpdir(), 'agent-workers-config-watchdog-'));
    roots.push(root);
    process.env.AGENT_WORKERS_STATE_DIR = join(root, 'state');
    process.env.AGENT_WORKERS_WORKTREE_ROOT = join(root, 'worktrees');
    process.env.AGENT_WORKERS_DSH_HOME = join(root, 'dsh-home');
    process.env.AGENT_WORKERS_ALLOWED_ROOTS = process.cwd();
  });

  afterEach(() => {
    for (const name of WATCHDOG_ENV) {
      const value = watchdogSaved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('defaults to warn-only watchdogs with both budgets off', async () => {
    const config = await loadConfig();
    expect(config.stallMs).toBe(120_000);
    expect(config.loopRepeat).toBe(4);
    expect(config.toolErrorLimit).toBe(5);
    expect(config.maxSteps).toBeUndefined();
    expect(config.maxCostUsd).toBeUndefined();
    expect(config.watchdogAction).toBe('warn');
  });

  it('enables the control API by default and accepts explicit off values', async () => {
    let config = await loadConfig();
    expect(config.control).toBe(true);

    for (const value of ['0', 'false', 'no', 'off']) {
      process.env.AGENT_WORKERS_CONTROL = value;
      config = await loadConfig();
      expect(config.control).toBe(false);
    }

    delete process.env.AGENT_WORKERS_CONTROL;
    process.env.DSH_WORKERS_CONTROL = 'off';
    config = await loadConfig();
    expect(config.control).toBe(false);
  });

  it('treats blank plugin paths as unset', async () => {
    const xdg = join(roots.at(-1) ?? tmpdir(), 'xdg');
    process.env.XDG_STATE_HOME = xdg;
    process.env.AGENT_WORKERS_STATE_DIR = '';
    process.env.AGENT_WORKERS_WORKTREE_ROOT = ' ';
    process.env.AGENT_WORKERS_DSH_HOME = '';
    const config = await loadConfig();
    expect(config.stateDir).toBe(join(xdg, 'agent-workers'));
    expect(config.worktreeRoot).toBe(join(xdg, 'agent-workers', 'worktrees'));
    expect(config.dshHome).toBe(join(xdg, 'agent-workers', 'dsh-home'));
  });

  it('accepts the legacy DSH_WORKERS prefix and prefers AGENT_WORKERS', async () => {
    process.env.DSH_WORKERS_MAX_CONCURRENT = '4';
    process.env.DSH_WORKERS_BACKEND = 'pi';
    let config = await loadConfig();
    expect(config.maxConcurrent).toBe(4);
    expect(config.backend).toBe('pi');

    process.env.AGENT_WORKERS_MAX_CONCURRENT = '5';
    process.env.AGENT_WORKERS_BACKEND = 'dsh';
    config = await loadConfig();
    expect(config.maxConcurrent).toBe(5);
    expect(config.backend).toBe('dsh');
  });

  it('reuses an existing legacy dsh-workers state dir', async () => {
    const xdg = join(roots.at(-1) ?? tmpdir(), 'xdg-legacy');
    await mkdir(join(xdg, 'dsh-workers'), { recursive: true });
    process.env.XDG_STATE_HOME = xdg;
    delete process.env.AGENT_WORKERS_STATE_DIR;
    const config = await loadConfig();
    expect(config.stateDir).toBe(join(xdg, 'dsh-workers'));
  });

  it('parses the watchdog env vars and their float budget', async () => {
    process.env.AGENT_WORKERS_STALL_S = '45';
    process.env.AGENT_WORKERS_LOOP_REPEAT = '7';
    process.env.AGENT_WORKERS_TOOL_ERROR_LIMIT = '9';
    process.env.AGENT_WORKERS_MAX_STEPS = '12';
    process.env.AGENT_WORKERS_MAX_COST_USD = '0.125';
    process.env.AGENT_WORKERS_WATCHDOG_ACTION = 'cancel';
    const config = await loadConfig();
    expect(config.stallMs).toBe(45_000);
    expect(config.loopRepeat).toBe(7);
    expect(config.toolErrorLimit).toBe(9);
    expect(config.maxSteps).toBe(12);
    expect(config.maxCostUsd).toBe(0.125);
    expect(config.watchdogAction).toBe('cancel');
  });

  it('rejects values outside the documented bounds', async () => {
    process.env.AGENT_WORKERS_STALL_S = '29';
    await expect(loadConfig()).rejects.toThrow(/AGENT_WORKERS_STALL_S/);
    process.env.AGENT_WORKERS_STALL_S = '120';

    process.env.AGENT_WORKERS_LOOP_REPEAT = '21';
    await expect(loadConfig()).rejects.toThrow(/AGENT_WORKERS_LOOP_REPEAT/);
    process.env.AGENT_WORKERS_LOOP_REPEAT = '4';

    process.env.AGENT_WORKERS_TOOL_ERROR_LIMIT = '0';
    await expect(loadConfig()).rejects.toThrow(/AGENT_WORKERS_TOOL_ERROR_LIMIT/);
    process.env.AGENT_WORKERS_TOOL_ERROR_LIMIT = '5';

    process.env.AGENT_WORKERS_MAX_STEPS = '0';
    await expect(loadConfig()).rejects.toThrow(/AGENT_WORKERS_MAX_STEPS/);
    process.env.AGENT_WORKERS_MAX_STEPS = '10';

    process.env.AGENT_WORKERS_MAX_COST_USD = '-1';
    await expect(loadConfig()).rejects.toThrow(/AGENT_WORKERS_MAX_COST_USD/);
    process.env.AGENT_WORKERS_MAX_COST_USD = '1';

    process.env.AGENT_WORKERS_WATCHDOG_ACTION = 'kill';
    await expect(loadConfig()).rejects.toThrow(/AGENT_WORKERS_WATCHDOG_ACTION/);
  });
});

describe('credential resolution', () => {
  it('reads a named credential from the opted-in DSH store', async () => {
    const config = await credentialStore(
      'refs:\n  DEEPSEEK_API_KEY: ds-test\n  OPENROUTER_CHAT_API_KEY: "or-test"\n',
    );
    await expect(resolveCredential(config, 'DEEPSEEK_API_KEY')).resolves.toBe('ds-test');
    await expect(resolveCredential(config, 'OPENROUTER_CHAT_API_KEY')).resolves.toBe('or-test');
  });

  it('maps the worker keys to their credential names', async () => {
    const config = await credentialStore(
      'refs:\n  DEEPSEEK_API_KEY: ds-test\n  OPENROUTER_CHAT_API_KEY: or-test\n  OPENCODE_GO_API_KEY: oc-test\n',
    );
    await expect(resolveApiKey(config)).resolves.toBe('ds-test');
    await expect(resolveOpenRouterChatApiKey(config)).resolves.toBe('or-test');
    await expect(resolveOpenCodeGoApiKey(config)).resolves.toBe('oc-test');
  });

  it('prefers the process environment over the store', async () => {
    const config = await credentialStore('refs:\n  OPENROUTER_CHAT_API_KEY: from-file\n');
    process.env.OPENROUTER_CHAT_API_KEY = 'from-env';
    await expect(resolveOpenRouterChatApiKey(config)).resolves.toBe('from-env');
  });

  it('does not read the store unless the operator opted in', async () => {
    const config = await credentialStore('refs:\n  OPENROUTER_CHAT_API_KEY: from-file\n');
    await expect(
      resolveOpenRouterChatApiKey({ ...config, useDshCredentials: false }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the credential is missing or the file is unreadable', async () => {
    const config = await credentialStore('refs:\n  DEEPSEEK_API_KEY: ds-test\n');
    await expect(resolveOpenRouterChatApiKey(config)).resolves.toBeUndefined();
    await expect(
      resolveOpenRouterChatApiKey({
        ...config,
        credentialsFile: join(tmpdir(), 'missing-dsh-credentials.yaml'),
      }),
    ).resolves.toBeUndefined();
  });
});
