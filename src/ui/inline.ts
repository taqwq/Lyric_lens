/* Puts each translation directly under its original line, inside Genius' own markup. */
import { NOTE_LABELS, type LineResult, type SongRecord } from '../core/types';
import type { PageSong } from '../genius/extract';
import { h, isolateClicks } from './dom';

type LineState = 'done' | 'stale' | 'pending';

export interface RenderInput {
  page: PageSong;
  record: SongRecord | null;
  /** Earlier results, shown dimmed for lines not yet redone during a re-translation. */
  fallback?: SongRecord | null;
  /** Show placeholders for lines still on their way. */
  running: boolean;
}

function insertAfter(anchor: Node, el: Node): boolean {
  const parent = anchor.parentNode;
  if (!parent || !anchor.isConnected) return false;
  parent.insertBefore(el, anchor.nextSibling);
  return true;
}

export class InlineRenderer {
  private readonly els = new Map<number, HTMLElement>();
  private readonly sigs = new Map<number, string>();
  /** Lines whose notes the reader opened; kept open across re-renders. */
  private readonly open = new Set<string>();
  private page: PageSong | null = null;

  render({ page, record, fallback, running }: RenderInput): void {
    // Same song re-read (Genius re-rendered, URL changed for an annotation…): keep the
    // existing nodes that are still in place instead of rebuilding everything.
    if (this.page && this.page.path !== page.path) {
      this.clear();
      this.open.clear();
    }
    this.page = page;
    for (const [i, el] of this.els) {
      if (i < page.source.lines.length) continue;
      el.remove();
      this.els.delete(i);
      this.sigs.delete(i);
    }

    page.source.lines.forEach((line, i) => {
      const anchor = page.anchors[i];
      const fresh = record?.lines[line.key];
      const old = fresh ? undefined : fallback?.lines[line.key];
      const state: LineState | null = fresh ? 'done' : old ? 'stale' : running ? 'pending' : null;
      const current = this.els.get(i);

      if (!state || !anchor) {
        current?.remove();
        this.els.delete(i);
        this.sigs.delete(i);
        return;
      }
      const result = fresh ?? old;
      const sig = `${line.key}|${state}|${result?.ja ?? ''}|${JSON.stringify(result?.notes ?? [])}`;
      if (current && this.sigs.get(i) === sig && current.isConnected && current.previousSibling === anchor) return;

      const next = this.build(line.key, state, result);
      if (current?.dataset.state === 'pending' && state === 'done') next.classList.add('ll-arrived');
      current?.remove();
      if (insertAfter(anchor, next)) {
        this.els.set(i, next);
        this.sigs.set(i, sig);
      } else {
        this.els.delete(i);
        this.sigs.delete(i);
      }
    });
  }

  /** True when Genius re-rendered and removed some of our nodes or their anchors. */
  damaged(): boolean {
    if (!this.page) return false;
    for (const [i, el] of this.els) {
      if (!el.isConnected || !this.page.anchors[i]?.isConnected) return true;
    }
    return false;
  }

  clear(): void {
    this.els.forEach((el) => el.remove());
    this.els.clear();
    this.sigs.clear();
    document.querySelectorAll('.ll-line').forEach((el) => el.remove());
    this.page = null;
  }

  private build(key: string, state: LineState, result: LineResult | undefined): HTMLElement {
    const root = h('span', { class: 'll-line', lang: 'ja', dataset: { state } });
    isolateClicks(root);
    root.appendChild(h('span', { class: 'll-ja' }, state === 'pending' ? '' : result?.ja ?? ''));
    if (state === 'pending') {
      root.setAttribute('aria-label', '翻訳中');
      return root;
    }
    const notes = result?.notes ?? [];
    if (!notes.length) return root;

    const list = h('span', { class: 'll-notes', hidden: !this.open.has(key) },
      notes.map((note) => h('span', { class: 'll-note' },
        h('span', { class: 'll-note-head' },
          h('span', { class: 'll-note-kind' }, NOTE_LABELS[note.kind] ?? note.kind),
          h('span', { class: 'll-note-span', lang: 'en' }, note.span),
          note.unsure ? h('span', { class: 'll-note-unsure', title: 'モデルの推測を含む' }, '推測') : null,
        ),
        h('span', { class: 'll-note-text' }, note.text),
      )),
    );
    const button = h('button', {
      class: 'll-note-btn',
      type: 'button',
      title: '注釈を開く',
      'aria-expanded': String(this.open.has(key)),
      onclick: (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const show = list.hidden;
        list.hidden = !show;
        button.setAttribute('aria-expanded', String(show));
        if (show) this.open.add(key); else this.open.delete(key);
      },
    }, notes.length > 1 ? `注 ${notes.length}` : '注');
    root.append(button, list);
    return root;
  }
}
