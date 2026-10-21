import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readStartTime } from '../proc.js';

export const CONTROL_PROTOCOL = 'agent-workers-control/1';

const DESCRIPTOR_FILE = /^[A-Za-z0-9_-]+\.json$/;
const OWNER_ID = /^[A-Za-z0-9_-]+$/;

export interface ControlEndpoint {
  base_url: string;
  port: number;
  token: string;
}

export interface OwnerDescriptor {
  protocol: typeof CONTROL_PROTOCOL;
  owner_id: string;
  pid: number;
  pid_start?: string;
  started_at: string;
  version: string;
  state_dir: string;
  control: ControlEndpoint | null;
  ready: boolean;
}

export function controlDir(stateDir: string): string {
  return join(stateDir, 'control');
}

function descriptorPath(stateDir: string, ownerId: string): string {
  if (!OWNER_ID.test(ownerId)) throw new Error('invalid owner id');
  return join(controlDir(stateDir), `${ownerId}.json`);
}

/**
 * Write the lease atomically so readers never see a partial descriptor. The
 * temp file is private too and only becomes visible under its final name after
 * the rename.
 */
export async function writeDescriptor(
  stateDir: string,
  descriptor: OwnerDescriptor,
): Promise<void> {
  const dir = controlDir(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = descriptorPath(stateDir, descriptor.owner_id);
  const temp = join(dir, `.${descriptor.owner_id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(descriptor), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function removeDescriptor(stateDir: string, ownerId: string): Promise<void> {
  try {
    await rm(descriptorPath(stateDir, ownerId), { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function isDescriptor(value: unknown, fileOwnerId: string): value is OwnerDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = value as Record<string, unknown>;
  return (
    descriptor.protocol === CONTROL_PROTOCOL &&
    descriptor.owner_id === fileOwnerId &&
    typeof descriptor.pid === 'number' &&
    Number.isInteger(descriptor.pid) &&
    descriptor.pid > 0
  );
}

/** Valid descriptors only; a missing or unreadable control dir reads as empty. */
export async function readDescriptors(stateDir: string): Promise<OwnerDescriptor[]> {
  const dir = controlDir(stateDir);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const descriptors: OwnerDescriptor[] = [];
  for (const entry of entries) {
    if (!DESCRIPTOR_FILE.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if ((info.mode & 0o077) !== 0) continue;
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const fileOwnerId = entry.name.slice(0, -'.json'.length);
      if (!isDescriptor(parsed, fileOwnerId)) continue;
      descriptors.push(parsed);
    } catch {
      // Invalid, unreadable or racing descriptors are ignored.
    }
  }
  return descriptors.sort((a, b) => a.owner_id.localeCompare(b.owner_id));
}

/**
 * A lease is live while its pid exists and, when the descriptor recorded a
 * start time, the pid still belongs to that same process (no pid reuse).
 */
export async function isOwnerLive(descriptor: OwnerDescriptor): Promise<boolean> {
  if (!Number.isInteger(descriptor.pid) || descriptor.pid <= 0) return false;
  try {
    process.kill(descriptor.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (descriptor.pid_start === undefined) return true;
  const current = await readStartTime(descriptor.pid);
  if (current === undefined) return true;
  return current === descriptor.pid_start;
}

export async function liveOwnerIds(stateDir: string, selfOwnerId: string): Promise<Set<string>> {
  const live = new Set<string>();
  for (const descriptor of await readDescriptors(stateDir)) {
    if (descriptor.owner_id === selfOwnerId) continue;
    if (await isOwnerLive(descriptor)) live.add(descriptor.owner_id);
  }
  return live;
}

export async function pruneStaleDescriptors(stateDir: string): Promise<void> {
  for (const descriptor of await readDescriptors(stateDir)) {
    let live = false;
    try {
      live = await isOwnerLive(descriptor);
    } catch {
      continue;
    }
    if (live) continue;
    try {
      await removeDescriptor(stateDir, descriptor.owner_id);
    } catch {
      // Another process may be racing the same cleanup.
    }
  }
}
