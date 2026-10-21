#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('fake pi 1.0.0\n');
  process.exit(0);
}

const args = process.argv.slice(2);
await writeFile(process.env.PI_ARGV_FILE, JSON.stringify(args));

const dirIndex = args.indexOf('--session-dir');
const idIndex = args.indexOf('--session-id');
if (dirIndex >= 0) {
  const dir = args[dirIndex + 1];
  const id = idIndex >= 0 ? args[idIndex + 1] : 'fixture-session';
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), '{"type":"session"}\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  await writeFile(process.env.PI_STDIN_FILE, input);
  process.stdout.write(await readFile(process.env.PI_FIXTURE, 'utf8'));
});
