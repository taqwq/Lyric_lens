// Bundles a TypeScript entry for Node and runs it: node scripts/run.mjs scripts/live-test.ts [args…]
import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/run.mjs <entry.ts> [args…]');
  process.exit(1);
}
mkdirSync('tmp', { recursive: true });
const outfile = resolve(join('tmp', basename(entry).replace(/\.ts$/, '.mjs')));
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  packages: 'external',
  loader: { '.css': 'text' },
  define: { __VERSION__: '"dev"', __DEV__: 'false' },
  logLevel: 'warning',
});
process.argv = [process.argv[0], outfile, ...args];
await import(pathToFileURL(outfile).href);
