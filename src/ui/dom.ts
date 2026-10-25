/* Tiny DOM helpers. Every element Lyric Lens adds uses classes starting with "ll-",
 * which is how the lyrics reader recognises (and ignores) our own nodes. */

export type Child = Node | string | number | null | undefined | false | Child[];

export type Props = {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
};

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'type', 'title', 'placeholder', 'href', 'target', 'rel', 'tabIndex', 'htmlFor', 'name', 'min', 'max', 'step', 'autocomplete', 'spellcheck']);

function append(parent: Node, child: Child): void {
  if (child == null || child === false) return;
  if (Array.isArray(child)) { child.forEach((c) => append(parent, c)); return; }
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || (value === false && !PROPERTY_KEYS.has(key))) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style') el.style.cssText = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (PROPERTY_KEYS.has(key)) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  children.forEach((c) => append(el, c));
  return el;
}

export function injectStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.className = 'll-style';
  style.textContent = css;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Keeps clicks on our elements from reaching Genius: a translation placed inside an
 *  annotation link must not open the annotation or follow the link. */
export function isolateClicks(el: HTMLElement): void {
  const stop = (e: Event) => e.stopPropagation();
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.parentElement?.closest('a[href]')) e.preventDefault();
  });
  el.addEventListener('mousedown', stop);
  el.addEventListener('mouseup', stop);
  el.addEventListener('pointerdown', stop);
  el.addEventListener('pointerup', stop);
}
