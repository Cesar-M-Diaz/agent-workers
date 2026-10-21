import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneExpiredJobs } from '../src/admin.js';

async function writeJob(
  root: string,
  id: string,
  status: string,
  finishedAt?: string,
): Promise<void> {
  const dir = join(root, 'jobs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'job.json'),
    JSON.stringify({ id, status, createdAt: new Date().toISOString(), finishedAt }),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('job retention', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workers-admin-test-'));
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeJob(root, 'j_old', 'succeeded', old);
    await writeJob(root, 'j_new', 'succeeded', new Date().toISOString());
    await writeJob(root, 'j_active', 'running', old);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes expired terminal jobs but keeps recent and active jobs', async () => {
    const result = await pruneExpiredJobs(root, 7);
    expect(result.deleted).toEqual(['j_old']);
    expect(result.preserved_dirty).toEqual([]);
    expect(await exists(join(root, 'jobs', 'j_old'))).toBe(false);
    expect(await exists(join(root, 'jobs', 'j_new'))).toBe(true);
    expect(await exists(join(root, 'jobs', 'j_active'))).toBe(true);
  });

  it('is disabled when retention is zero', async () => {
    await writeJob(root, 'j_old_2', 'succeeded', new Date(0).toISOString());
    const result = await pruneExpiredJobs(root, 0);
    expect(result.deleted).toEqual([]);
    expect(await exists(join(root, 'jobs', 'j_old_2'))).toBe(true);
  });
});
