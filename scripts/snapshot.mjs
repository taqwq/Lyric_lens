// Saves a real Genius page for local testing, with Genius' scripts removed and the dev
// build + mock LLM injected: node scripts/snapshot.mjs <genius-url> [--mobile]
// Output: dev/real/<slug>[-mobile].html (gitignored), served by scripts/serve.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2];
const mobile = process.argv.includes('--mobile');
if (!url) {
  console.error('usage: node scripts/snapshot.mjs <genius-url> [--mobile]');
  process.exit(1);
}
const ua = mobile
  ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const res = await fetch(url, { headers: { 'user-agent': ua, 'accept-language': 'en-US,en;q=0.9' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
let html = await res.text();
html = html
  .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*rel="(?:preload|modulepreload|prefetch)"[^>]*>/gi, '')
  .replace('</body>', '<script src="/mock-llm.js"></script><script src="/lyric-lens.dev.user.js"></script></body>');
const slug = new URL(url).pathname.split('/').filter(Boolean).pop() + (mobile ? '-mobile' : '');
mkdirSync('dev/real', { recursive: true });
writeFileSync(`dev/real/${slug}.html`, html);
console.log(`saved dev/real/${slug}.html (${(html.length / 1024).toFixed(0)} KB) → http://localhost:5178/real/${slug}.html`);
