/*
 * Reads lyrics out of Genius' DOM. Lines end at <br>; annotation links (<a>) may wrap part
 * of a line or several lines with <br> inside. For each line we remember the node after
 * which its translation goes: the <br> that ends it (inside an annotation if the
 * annotation continues past it), or the outermost wrapper that ends with the line.
 */
import { buildSong, isSectionHeader, type RawLyricRow } from '../core/song';
import type { SongMeta, SongSource } from '../core/types';
import { songIdFromPage } from './annotations';

export const OWN_CLASS_PREFIX = 'll-';

const BLOCK_TAGS = new Set(['DIV', 'P', 'SECTION', 'HEADER', 'ARTICLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'BLOCKQUOTE', 'FIGURE']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'SVG', 'svg', 'IMG', 'IFRAME', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT']);

const NOISE = [
  /^you might also like$/i,
  /^\d[\d,.]*[km]?\s*embed$/i,
  /^embed$/i,
  /^see .+ live\s*(get tickets.*)?$/i,
  /^get tickets\b/i,
  /^\d[\d,.]*\s+contributors?\b/i,
  /^translations?$/i,
  /^\[?\s*read more\s*\]?$/i,
];

export function isOwnNode(node: Node | null): boolean {
  if (!node || node.nodeType !== 1) return false;
  const el = node as Element;
  return typeof el.className === 'string' && el.className.split(/\s+/).some((c) => c.startsWith(OWN_CLASS_PREFIX));
}

function shouldSkip(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-exclude-from-selection') || isOwnNode(el) || el.getAttribute('aria-hidden') === 'true';
}

export function lyricsContainers(doc: Document = document): HTMLElement[] {
  let nodes = Array.from(doc.querySelectorAll<HTMLElement>('[data-lyrics-container="true"]'));
  if (!nodes.length) nodes = Array.from(doc.querySelectorAll<HTMLElement>('[data-lyrics-container]'));
  return nodes.filter((n) => !n.closest('[class^="ll-"], [class*=" ll-"]'));
}

function cleanText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/\s*\d[\d,.]*[KM]?\s*Embed$/i, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** True if something visible that belongs to the lyrics follows `node` among its siblings. */
function hasContentAfter(node: Node): boolean {
  for (let s = node.nextSibling; s; s = s.nextSibling) {
    if (s.nodeType === 3) {
      if (s.textContent?.trim()) return true;
    } else if (s.nodeType === 1) {
      const el = s as Element;
      if (isOwnNode(el)) continue;
      if (el.tagName === 'BR' || el.textContent?.trim() || el.querySelector('br')) return true;
    }
  }
  return false;
}

/** Climbs out of inline wrappers that end together with the line, stopping at the container. */
function resolveAnchor(node: Node, container: Element): Node {
  let ref = node;
  while (ref.parentNode && ref.parentNode !== container && !hasContentAfter(ref)) {
    ref = ref.parentNode;
  }
  return ref;
}

export interface Extraction {
  rows: RawLyricRow[];
  /** anchors[i] = node after which line i's translation is inserted. */
  anchors: Node[];
  containers: HTMLElement[];
}

export function extractLyrics(doc: Document = document): Extraction | null {
  const containers = lyricsContainers(doc);
  if (!containers.length) return null;
  const rows: RawLyricRow[] = [];
  const anchors: Node[] = [];

  for (const container of containers) {
    let text = '';
    let last: Node | null = null;

    const flush = (endNode: Node | null) => {
      const line = cleanText(text);
      text = '';
      const anchorSource = endNode ?? last;
      last = null;
      if (!line || NOISE.some((re) => re.test(line))) return;
      if (isSectionHeader(line)) {
        rows.push({ kind: 'header', text: line });
        return;
      }
      if (!anchorSource) return;
      rows.push({ kind: 'line', text: line });
      anchors.push(resolveAnchor(anchorSource, container));
    };

    const walk = (parent: Node) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === 3) {
          const t = child.textContent ?? '';
          if (t) {
            text += t;
            if (t.trim()) last = child;
          }
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (el.tagName === 'BR') {
          flush(el);
          continue;
        }
        if (shouldSkip(el)) continue;
        if (BLOCK_TAGS.has(el.tagName)) {
          flush(null);
          walk(el);
          flush(null);
          continue;
        }
        walk(el);
      }
    };

    walk(container);
    flush(null);
  }

  if (!rows.some((r) => r.kind === 'line')) return null;
  return { rows, anchors, containers };
}

/* ---------- metadata ---------- */

function text(doc: Document, selector: string): string {
  return doc.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export function extractMeta(doc: Document = document): SongMeta {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ?? '';
  const [ogArtist, ...ogTitle] = og.split(/\s+[–—]\s+/);
  let title = text(doc, 'h1[class*="SongHeader"][class*="Title"]') || text(doc, 'h1[class*="Title"]');
  let artist = text(doc, 'a[class*="SongHeader"][class*="Artist"]') || text(doc, '[class*="HeaderArtistAndTracklist"] a');
  if (!title && ogTitle.length) title = ogTitle.join(' – ');
  if (!artist && ogTitle.length) artist = ogArtist ?? '';
  if (!title) title = doc.title.replace(/\s*Lyrics\s*\|.*$/i, '').trim();
  // Not just any /albums/ link: the About text and "other albums" lists link to unrelated ones.
  const album = text(doc, 'a[class*="PrimaryAlbum__Title"]')
    || text(doc, '[class*="AlbumCredit"] a[href*="/albums/"]')
    || text(doc, '[class*="SongHeader"] a[href*="/albums/"]');
  const aboutEl = doc.querySelector('[class*="SongDescription__Container"]') ?? doc.querySelector('[class*="About__Container"] [class*="RichText"]');
  const about = aboutEl?.textContent?.replace(/\s+/g, ' ').replace(/\b(Expand|Read More)\b\s*$/i, '').trim() ?? '';
  const meta: SongMeta = { title, artist };
  if (album) meta.album = album;
  if (about.length > 40) meta.about = about;
  return meta;
}

/** Stable identity of the open song. Opening an annotation rewrites the URL to the
 *  annotation's id (genius.com/11592958) while the page stays on the same song, so the
 *  canonical song URL wins over location when it is one. */
export function songPath(loc: Location = location, doc?: Document): string {
  const canonical = doc?.querySelector('link[rel="canonical"]')?.getAttribute('href')
    ?? doc?.querySelector('meta[property="og:url"]')?.getAttribute('content');
  if (canonical) {
    try {
      const path = new URL(canonical, loc.href).pathname.replace(/\/+$/, '');
      if (/-lyrics$/i.test(path)) return path;
    } catch { /* malformed: fall back to location */ }
  }
  return loc.pathname.replace(/\/+$/, '') || '/';
}

export interface PageSong {
  path: string;
  /** Genius song id, for its annotations API. */
  songId: string | null;
  source: SongSource;
  anchors: Node[];
  containers: HTMLElement[];
}

export function readPage(doc: Document = document, loc: Location = location): PageSong | null {
  const extraction = extractLyrics(doc);
  if (!extraction) return null;
  const source = buildSong(extractMeta(doc), extraction.rows);
  if (!source.lines.length) return null;
  return { path: songPath(loc, doc), songId: songIdFromPage(doc), source, anchors: extraction.anchors, containers: extraction.containers };
}
