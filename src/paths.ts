import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2));
  return path;
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function pathOverlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/** Resolve a path and reject anything that escapes the configured roots. */
export async function resolveAllowedPath(
  input: string,
  allowedRoots: readonly string[],
  defaultBase: string,
): Promise<string> {
  const candidate = isAbsolute(input) ? input : resolve(defaultBase, input);
  let real: string;
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) throw new Error('not a directory');
    real = await realpath(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cwd is not a readable directory: ${message}`);
  }
  for (const root of allowedRoots) {
    const realRoot = await realpath(root);
    if (isWithin(realRoot, real)) return real;
  }
  throw new Error('cwd is outside AGENT_WORKERS_ALLOWED_ROOTS');
}

export async function resolveAllowedRoots(values: readonly string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const value of values) {
    const expanded = resolve(expandHome(value));
    let real: string;
    try {
      const info = await stat(expanded);
      if (!info.isDirectory()) throw new Error('not a directory');
      real = await realpath(expanded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`allowed root is not a readable directory: ${value}: ${message}`);
    }
    if (!roots.includes(real)) roots.push(real);
  }
  if (roots.length === 0) throw new Error('at least one allowed root is required');
  return roots;
}
