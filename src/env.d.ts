declare const __VERSION__: string;
declare const __DEV__: boolean;

declare module '*.css' {
  const css: string;
  export default css;
}

/* Minimal userscript-manager typings. Every access goes through src/platform/gm.ts,
 * which tolerates any of these being absent (Tampermonkey, Violentmonkey, iOS Userscripts…). */

interface GMResponse {
  status: number;
  statusText?: string;
  responseHeaders?: string;
  responseText?: string;
  response?: unknown;
  readyState?: number;
  finalUrl?: string;
}

interface GMRequestDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  responseType?: 'text' | 'json' | 'stream' | 'arraybuffer' | 'blob';
  onload?: (r: GMResponse) => void;
  onerror?: (r: GMResponse) => void;
  ontimeout?: (r: GMResponse) => void;
  onabort?: (r: GMResponse) => void;
  onprogress?: (r: GMResponse) => void;
  onloadstart?: (r: GMResponse) => void;
  onreadystatechange?: (r: GMResponse) => void;
}

interface GMHandle { abort?: () => void }

declare function GM_xmlhttpRequest(details: GMRequestDetails): GMHandle;
declare function GM_getValue<T = unknown>(key: string, fallback?: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_registerMenuCommand(label: string, fn: () => void): unknown;
declare const GM_info: { scriptHandler?: string; version?: string; script?: { version?: string } } | undefined;
declare const GM: {
  xmlHttpRequest?: (details: GMRequestDetails) => GMHandle | Promise<unknown>;
  getValue?: <T = unknown>(key: string, fallback?: T) => Promise<T>;
  setValue?: (key: string, value: unknown) => Promise<void>;
  deleteValue?: (key: string) => Promise<void>;
  listValues?: () => Promise<string[]>;
  registerMenuCommand?: (label: string, fn: () => void) => unknown;
} | undefined;
