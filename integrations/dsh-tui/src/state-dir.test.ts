import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { resolveStateDir } from './state-dir.js';

const KEYS = ['AGENT_WORKERS_STATE_DIR', 'DSH_WORKERS_STATE_DIR', 'XDG_STATE_HOME'] as const;
let saved: Record<string, string | undefined> = {};
const temps: string[] = [];

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (temps.length > 0) {
    const path = temps.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-workers-state-dir-'));
  temps.push(path);
  return path;
}

test('config.stateDir wins over every environment source', async () => {
  const explicit = join(await tempDir(), 'explicit');
  const envAgent = join(await tempDir(), 'env-agent');
  const envLegacy = join(await tempDir(), 'env-legacy');
  process.env.AGENT_WORKERS_STATE_DIR = envAgent;
  process.env.DSH_WORKERS_STATE_DIR = envLegacy;
  assert.equal(resolveStateDir({ stateDir: explicit }), explicit);
  assert.equal(resolveStateDir({ stateDir: '   ' }), envAgent);
});

test('AGENT_WORKERS_STATE_DIR wins over DSH_WORKERS_STATE_DIR', async () => {
  const agent = join(await tempDir(), 'agent');
  const legacy = join(await tempDir(), 'legacy');
  process.env.AGENT_WORKERS_STATE_DIR = agent;
  process.env.DSH_WORKERS_STATE_DIR = legacy;
  assert.equal(resolveStateDir(), agent);
});

test('DSH_WORKERS_STATE_DIR is the fallback, and blank values count as unset', async () => {
  const legacy = join(await tempDir(), 'legacy-env');
  process.env.AGENT_WORKERS_STATE_DIR = '  ';
  process.env.DSH_WORKERS_STATE_DIR = legacy;
  assert.equal(resolveStateDir(), legacy);

  process.env.DSH_WORKERS_STATE_DIR = '';
  process.env.XDG_STATE_HOME = join(await tempDir(), 'xdg');
  assert.equal(resolveStateDir(), join(process.env.XDG_STATE_HOME, 'agent-workers'));
});

test('prefers an existing legacy dsh-workers directory under XDG_STATE_HOME', async () => {
  const xdg = await tempDir();
  process.env.XDG_STATE_HOME = xdg;
  const legacy = join(xdg, 'dsh-workers');
  await mkdir(legacy);
  assert.equal(resolveStateDir(), legacy);

  await rm(legacy, { recursive: true });
  assert.equal(resolveStateDir(), join(xdg, 'agent-workers'));
});

test('falls back to ~/.local/state when XDG_STATE_HOME is unset', async () => {
  const home = await tempDir();
  const legacy = join(home, '.local', 'state', 'dsh-workers');
  await mkdir(legacy, { recursive: true });
  assert.equal(resolveStateDir({ home }), legacy);

  await rm(legacy, { recursive: true });
  assert.equal(resolveStateDir({ home }), join(home, '.local', 'state', 'agent-workers'));
});
