#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

if (process.argv.includes('--version')) {
  process.stdout.write('fake pi 1.0.0\n');
  process.exit(0);
}

await writeFile(process.env.PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  await writeFile(process.env.PI_STDIN_FILE, input);
  process.stdout.write(await readFile(process.env.PI_FIXTURE, 'utf8'));
});
