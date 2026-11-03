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
  if (__DEV__) (window as unknown as { __ll: App }).__ll = app;
  registerMenu('Lyric Lensの設定', () => app.openSettings(null));
  app.start().catch((error) => console.error('[Lyric Lens] failed to start', error));
  console.info(`[Lyric Lens] v${__VERSION__}`);
}

if (document.body) boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });
