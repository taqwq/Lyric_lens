/*
 * Genius community annotations for the open song, read from Genius' own public JSON API
 * (same origin, no key, no LLM quota). They go into the prompt as reference material so
 * slang and reference notes rest on what annotators wrote rather than on model recall.
 */
import type { GeniusAnnotation } from '../core/types';

const cache = new Map<string, GeniusAnnotation[]>();

export function songIdFromPage(doc: Document = document): string | null {
  const selectors = [
    'meta[name="twitter:app:url:iphone"]',
    'meta[property="twitter:app:url:iphone"]',
    'meta[property="al:ios:url"]',
    'meta[name="newrelic-resource-path"]',
  ];
  for (const selector of selectors) {
    const id = /songs\/(\d+)/.exec(doc.querySelector(selector)?.getAttribute('content') ?? '')?.[1];
    if (id) return id;
  }
  return null;
}

interface ReferentJson {
  is_description?: boolean;
  fragment?: string;
  range?: { content?: string };
  annotations?: Array<{ body?: { plain?: string }; votes_total?: number; verified?: boolean; state?: string }>;
}

export function parseReferents(referents: ReferentJson[]): GeniusAnnotation[] {
  const out: GeniusAnnotation[] = [];
  for (const r of referents) {
    if (r.is_description) continue; // the song's About text is sent separately
    const ann = r.annotations?.[0];
    const text = ann?.body?.plain?.trim();
    const fragment = (r.range?.content || r.fragment || '').trim();
    if (!ann || !text || !fragment) continue;
    const votes = Number(ann.votes_total ?? 0);
    const trusted = ann.verified || ann.state === 'accepted';
    if (!trusted && votes < 3) continue;
    out.push({ fragment, text, votes: votes + (ann.verified ? 100 : 0) });
  }
  return out;
}

export async function fetchAnnotations(songId: string, opts: { origin?: string; timeoutMs?: number } = {}): Promise<GeniusAnnotation[]> {
  const hit = cache.get(songId);
  if (hit) return hit;
  const origin = opts.origin ?? location.origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  const out: GeniusAnnotation[] = [];
  let answered = false;
  try {
    for (let page = 1; page <= 3; page += 1) {
      const res = await fetch(`${origin}/api/referents?song_id=${encodeURIComponent(songId)}&per_page=50&page=${page}&text_format=plain`, {
        credentials: 'omit',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) break;
      answered = true;
      const json = await res.json() as { response?: { referents?: ReferentJson[]; next_page?: number | null } };
      out.push(...parseReferents(json.response?.referents ?? []));
      if (!json.response?.next_page) break;
    }
  } catch {
    /* best effort: translation works without them */
  } finally {
    clearTimeout(timer);
  }
  if (answered) cache.set(songId, out);
  return out;
}
