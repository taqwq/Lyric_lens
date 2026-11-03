// Bundles src/main.ts into a single userscript (dist/lyric-lens.user.js).
import * as esbuild from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

const connect = ['generativelanguage.googleapis.com'];

const header = [
  '// ==UserScript==',
  '// @name         Lyric Lens for Genius',
  '// @namespace    taq.replay.lyrics',
  `// @version      ${pkg.version}`,
  '// @description  Genius の歌詞の各行の下に、曲全体の文脈を踏まえた自然な日本語訳を添えます。読み違えやすい語句にだけ短い注を付けます。無料の Gemini API キーで動きます。',
  '// @author       taq',
  '// @match        https://genius.com/*',
  '// @match        https://*.genius.com/*',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM.xmlHttpRequest',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @grant        GM_deleteValue',
  '// @grant        GM_listValues',
  '// @grant        GM.getValue',
  '// @grant        GM.setValue',
  '// @grant        GM.deleteValue',
  '// @grant        GM.listValues',
  '// @grant        GM_registerMenuCommand',
  '// @grant        GM.registerMenuCommand',
  '// @grant        GM_info',
  ...connect.map((host) => `// @connect      ${host}`),
  '// @run-at       document-idle',
  '// @noframes',
  '// ==/UserScript==',
  '',
].join('\n');

const options = {
  entryPoints: [join(root, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  charset: 'utf8',
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __DEV__: JSON.stringify(dev),
  },
  banner: { js: header },
  outfile: join(root, dev ? 'dev/lyric-lens.dev.user.js' : 'dist/lyric-lens.user.js'),
  logLevel: 'info',
};

mkdirSync(join(root, 'dist'), { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
  if (!dev) {
    // Keep a copy of the header alone so managers can check for updates cheaply.
    writeFileSync(join(root, 'dist/lyric-lens.meta.js'), header);
  }
}
