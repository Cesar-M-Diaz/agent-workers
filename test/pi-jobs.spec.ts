import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { JobManager } from '../src/jobs.js';

const fakePi = `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
if (process.argv.includes('--version')) {
  process.stdout.write('fake pi 1.0.0\\n');
  process.exit(0);
}
await writeFile(process.env.PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const fixture = await readFile(process.env.PI_FIXTURE, 'utf8');
process.stdout.write(fixture);
`;

describe('JobManager pi backend', () => {
  let root: string;
  let repo: string;
  let manager: JobManager;
  let config: Config;
  let argvFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-workers-pi-test-'));
    repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'README.md'), 'base\n');
    const fake = join(root, 'fake-pi.mjs');
    await writeFile(fake, fakePi, { mode: 0o700 });
    await chmod(fake, 0o700);
    argvFile = join(root, 'argv.json');
    config = {
      backend: 'pi',
      dshBin: 'true',
      piBin: fake,
      allowedRoots: [repo],
      stateDir: join(root, 'state'),
      worktreeRoot: join(root, 'worktrees'),
      dshHome: join(root, 'dsh-home'),
      maxConcurrent: 1,
      maxQueue: 2,
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      maxDepth: 1,
      retentionDays: 7,
      useDshCredentials: false,
      credentialsFile: join(root, 'credentials.yaml'),
      envAllow: ['PATH', 'HOME', 'PI_FIXTURE', 'PI_ARGV_FILE'],
      stallMs: 120_000,
      loopRepeat: 4,
      toolErrorLimit: 5,
      watchdogAction: 'warn',
      piDefaultProfile: 'default',
      piProfilesFile: join(root, 'pi-profiles.json'),
      piModel: 'openrouter/deepseek/deepseek-v4.1-flash-1017:low',
      piThinking: 'low',
      piAgentDir: '',
    };
    await mkdir(config.stateDir);
    await mkdir(config.worktreeRoot);
    await mkdir(config.dshHome);
    process.env.PI_FIXTURE = join(process.cwd(), 'test/fixtures/pi/json-basic.jsonl');
    process.env.PI_ARGV_FILE = argvFile;
    manager = new JobManager(config);
    await manager.init();
  });

  afterAll(async () => {
    await manager.shutdown();
    delete process.env.PI_FIXTURE;
    delete process.env.PI_ARGV_FILE;
    await rm(root, { recursive: true, force: true });
  });

  it('runs a pi job, normalizes events, and reports backend/cost', async () => {
    const started = await manager.start({
      task: 'review this',
      access: 'read-only',
      backend: 'pi',
    });
    expect(started.backend).toBe('pi');
    expect(started.profile).toBe('default');

    const waited = await manager.wait([started.job_id], 'all', 10_000);
    expect(waited.jobs[0]?.status).toBe('succeeded');
    const result = await manager.result(started.job_id, 1000, new Set(['final']));
    expect(result.status).toBe('succeeded');
    expect(result.final).toBe('hi');
    expect(result.backend).toBe('pi');
    expect(result.usage).toMatchObject({ inputTokens: 15, outputTokens: 5 });
    expect(result.cost_usd).toBeCloseTo(0.0005, 8);

    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        '--mode',
        'json',
        '--model',
        'openrouter/deepseek/deepseek-v4.1-flash-1017',
        '--thinking',
        'low',
        '--no-mcp',
        '--tools',
        'read,grep,find,ls',
      ]),
    );
    expect(argv.at(-1)).toBe('review this');

    const saved = JSON.parse(
      await readFile(join(config.stateDir, 'jobs', started.job_id, 'job.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved.schemaVersion).toBe(1);
    expect(saved.backend).toBe('pi');
    expect(saved.costUsd).toBeCloseTo(0.0005, 8);

    const events = (
      await readFile(join(config.stateDir, 'jobs', started.job_id, 'events.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toContain('tool_call');
    expect(events.map((event) => event.type)).toContain('final');
    expect(events.some((event) => event.type === 'session')).toBe(true);
  });
});
