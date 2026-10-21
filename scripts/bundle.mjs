import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const outdir = join(root, option('--outdir') ?? 'plugin-dist');
const check = args.includes('--check');

async function bundle(target) {
  await build({
    absWorkingDir: root,
    entryPoints: {
      server: join(root, 'src', 'server.ts'),
      ui: join(root, 'src', 'ui.ts'),
    },
    outdir: target,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    entryNames: '[name]',
    outExtension: { '.js': '.mjs' },
    // esbuild keeps the source `#!/usr/bin/env node` line at the top.
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    treeShaking: true,
    logLevel: 'warning',
  });
  await copyFile(join(root, 'src', 'dashboard.html'), join(target, 'dashboard.html'));
  await chmod(join(target, 'server.mjs'), 0o755);
  await chmod(join(target, 'ui.mjs'), 0o755);
}

if (check) {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-workers-bundle-'));
  try {
    await bundle(temporary);
    const stale = [];
    for (const name of ['server.mjs', 'ui.mjs', 'dashboard.html']) {
      const expected = await readFile(join(temporary, name));
      let actual;
      try {
        actual = await readFile(join(outdir, name));
      } catch {
        stale.push(`${name} is missing`);
        continue;
      }
      if (!expected.equals(actual)) stale.push(`${name} differs`);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `plugin-dist is stale: ${stale.join(', ')}. Run "pnpm bundle" and commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write('plugin-dist is up to date\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  await bundle(outdir);
  process.stdout.write(`bundled plugin-dist/server.mjs and plugin-dist/ui.mjs into ${outdir}\n`);
}
