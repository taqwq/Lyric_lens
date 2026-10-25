import { App } from './app';
import { injectStyle } from './ui/dom';
import css from './ui/styles.css';

function registerMenu(label: string, fn: () => void): void {
  try {
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn);
    else GM?.registerMenuCommand?.(label, fn);
  } catch { /* not supported by this manager */ }
}

function boot(): void {
  injectStyle('ll-style', css);
  const app = new App();
  registerMenu('Lyric Lens：設定', () => app.openSettings(false));
  registerMenu('Lyric Lens：この曲を訳す／続きを訳す', () => void app.translate());
  registerMenu('Lyric Lens：この曲を訳し直す', () => void app.translate(true));
  app.start().catch((error) => console.error('[Lyric Lens] failed to start', error));
  console.info(`[Lyric Lens] v${__VERSION__}`);
}

if (document.body) boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });
