/*
 * Build-time globals normally injected by scripts/build.mjs. vitest.config.ts has no `define`,
 * so test files import this module (as a separate side-effect import, first) before any
 * src module that reads them at load time (storage.ts reads __DEV__).
 */
const g = globalThis as Record<string, unknown>;
g.__DEV__ = false;
g.__VERSION__ = 'test';

export {};
