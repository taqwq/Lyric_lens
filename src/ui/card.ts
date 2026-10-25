/* "この曲について": the context the model worked out before translating, shown above the lyrics. */
import type { SongRecord } from '../core/types';
import type { PageSong } from '../genius/extract';
import { h, isolateClicks } from './dom';

let collapsed = false;

function modelLabel(model?: string): string {
  return model ? model.replace(/^models\//, '').replace(/^gemini-/, 'Gemini ') : '';
}

export function renderCard(page: PageSong | null, record: SongRecord | null): void {
  const existing = document.querySelector<HTMLElement>('.ll-card');
  const ctx = record?.context;
  const first = page?.containers[0];
  if (!page || !ctx?.about || !first?.isConnected) {
    existing?.remove();
    return;
  }
  const sig = `${page.path}|${ctx.about}|${ctx.voice}|${record?.model ?? ''}`;
  if (existing?.dataset.sig === sig && existing.isConnected && first.contains(existing)) return;
  existing?.remove();

  const card = h('div', { class: 'll-card', lang: 'ja', 'data-exclude-from-selection': 'true', dataset: { sig, collapsed: collapsed ? '1' : '' } },
    h('button', {
      class: 'll-card-head',
      type: 'button',
      'aria-expanded': String(!collapsed),
      onclick: () => {
        collapsed = !collapsed;
        card.dataset.collapsed = collapsed ? '1' : '';
        card.querySelector('.ll-card-head')?.setAttribute('aria-expanded', String(!collapsed));
      },
    },
      h('span', { class: 'll-card-chev', 'aria-hidden': 'true' }, '▾'),
      h('span', { class: 'll-card-label' }, 'この曲について'),
      h('span', { class: 'll-card-model' }, modelLabel(record?.model)),
    ),
    h('div', { class: 'll-card-body' },
      h('p', { class: 'll-card-about' }, ctx.about),
      ctx.voice ? h('p', { class: 'll-card-voice' }, ctx.voice) : null,
    ),
  );
  isolateClicks(card);
  // After Genius' own header block (contributors, translations…) if there is one.
  const header = Array.from(first.children).find((c) => c.hasAttribute('data-exclude-from-selection') && !c.classList.contains('ll-card'));
  first.insertBefore(card, header ? header.nextSibling : first.firstChild);
}
