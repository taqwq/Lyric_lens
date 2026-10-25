/*
 * Runs the real pipeline against a real provider and writes a side-by-side report.
 *
 *   npm run live -- <genius-url | tmp/songs/x.json> [--model gemini-3.6-flash] [--thinking low|medium|high] [--preset groq]
 *
 * Keys come from .env.local (GEMINI_API_KEY, GROQ_API_KEY, …). Reports go to tmp/ (gitignored).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { translateSong } from '../src/core/pipeline';
import { emptyRecord, songStatus } from '../src/core/song';
import type { SongSource } from '../src/core/types';
import { readPage } from '../src/genius/extract';
import { fetchAnnotations } from '../src/genius/annotations';
import { useFetchTransport } from '../src/platform/http';
import { setKV, type KV } from '../src/platform/storage';
import { newProvider } from '../src/store/settings';
import type { ThinkingLevel } from '../src/llm/types';

function env(): Record<string, string> {
  if (!existsSync('.env.local')) return {};
  return Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadSource(target: string): Promise<{ source: SongSource; path: string; songId?: string | null }> {
  if (target.endsWith('.json')) {
    return JSON.parse(readFileSync(target, 'utf8')) as { source: SongSource; path: string; songId?: string | null };
  }
  const res = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`fetch ${target}: HTTP ${res.status}`);
  const html = await res.text();
  const dom = new JSDOM(html, { url: target });
  const page = readPage(dom.window.document, dom.window.location as unknown as Location);
  if (!page) throw new Error('no lyrics found');
  mkdirSync('tmp/songs', { recursive: true });
  const slug = page.path.split('/').pop() ?? 'song';
  writeFileSync(`tmp/songs/${slug}.json`, JSON.stringify({ path: page.path, songId: page.songId, source: page.source }, null, 2));
  return { source: page.source, path: page.path, songId: page.songId };
}

const target = process.argv[2];
if (!target) {
  console.error('usage: npm run live -- <genius-url | tmp/songs/x.json> [--model id] [--thinking level] [--preset id]');
  process.exit(1);
}

useFetchTransport(true);
// Cooldowns persist across runs (tmp/kv.json) so exhausted models are not retried.
function fileKV(path: string): KV {
  const load = (): Record<string, string> => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  const save = (data: Record<string, string>) => writeFileSync(path, JSON.stringify(data, null, 1));
  return {
    get: async (k) => load()[k],
    set: async (k, v) => { const d = load(); d[k] = v; save(d); },
    del: async (k) => { const d = load(); delete d[k]; save(d); },
    keys: async () => Object.keys(load()),
  };
}
mkdirSync('tmp', { recursive: true });
setKV(fileKV('tmp/kv.json'));
const keys = env();
const presetId = arg('preset') ?? 'gemini';
const keyName = `${presetId.toUpperCase()}_API_KEY`;
const provider = { ...newProvider(presetId, keys[keyName] ?? ''), model: arg('model') ?? '' };
const thinking = (arg('thinking') ?? 'medium') as ThinkingLevel;

const { source, path, songId } = await loadSource(target);
if (songId && !process.argv.includes('--no-annotations')) {
  source.meta.annotations = await fetchAnnotations(songId, { origin: 'https://genius.com' });
}
console.log(`${source.meta.artist} – ${source.meta.title}: ${source.lines.length} lines, ${source.unique.length} unique, about=${source.meta.about?.length ?? 0} chars, annotations=${source.meta.annotations?.length ?? 0}`);

const record = emptyRecord(songId ? `id:${songId}` : `path:${path}`, path, source.meta);
const started = Date.now();
let firstLineAt = 0;
const outcome = await translateSong(source, record, {
  providers: [provider],
  thinking,
  onStatus: (s) => console.log(`  [status] ${s}`),
  onUpdate: (r) => {
    if (!firstLineAt && Object.keys(r.lines).length) firstLineAt = Date.now();
  },
}).catch((error) => {
  console.error('FAILED', error);
  return null;
});

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const notes = Object.values(record.lines).flatMap((l) => l.notes ?? []);
const status = songStatus(source, record);
console.log(`model=${outcome?.model ?? record.model} total=${seconds(Date.now() - started)}s firstLine=${firstLineAt ? seconds(firstLineAt - started) : '-'}s status=${status.kind} stop=${record.stop?.reason ?? '-'} notes=${notes.length}`);

const out: string[] = [`# ${source.meta.artist} – ${source.meta.title}`, '', `model: ${record.model} / thinking: ${thinking}`, ''];
if (record.song) out.push(`**誰が誰に**: ${record.song.who}`, '', `**この曲は**: ${record.song.what}`, '', `tone: ${record.song.tone ?? ''} / motifs: ${JSON.stringify(record.song.motifs ?? [])}`, '');
let section = -1;
for (const line of source.lines) {
  if (line.section !== section) {
    section = line.section;
    out.push('', `### ${source.sections[section]?.label ?? ''}`);
  }
  const r = record.lines[line.key];
  out.push(`- ${line.text}`, `  - ${r?.ja ?? '（未訳）'}`);
  if (line.occurrence > 0) continue;
  for (const n of r?.notes ?? []) out.push(`    - [${n.kind}${n.conjecture ? '?' : ''}${n.genius ? ` g:${n.genius}` : ''}] «${n.phrase}» ${n.text}`);
}
mkdirSync('tmp', { recursive: true });
const file = `tmp/report-${path.split('/').pop()}-${(record.model ?? 'x').replace(/[^\w.-]/g, '_')}-${thinking}.md`;
writeFileSync(file, out.join('\n'));
console.log(`report: ${file}`);
