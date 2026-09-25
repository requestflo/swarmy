import { toast } from '@swarmy/ui';
import { isDemo } from './is-demo';

/**
 * Demo mode has no controller. tRPC already resolves from the in-memory store
 * (demo-link.ts), but a few surfaces talk to the controller directly: Better
 * Auth (`/api/auth/*`), the terminal data plane (`/term/ws`), public status
 * JSON, app sign-in hops. This guard is the backstop: in demo mode, any request
 * to a controller path is refused locally (fetch → a 503 JSON response,
 * XHR → a network error, WebSocket/EventSource → a socket that closes at once)
 * and the visitor gets a friendly "this is a demo" toast. Nothing leaves the page.
 *
 * Imported for its side effect first thing in main.tsx, before the tRPC and
 * auth clients exist.
 */
const CONTROLLER_PATH = /^\/(api|term|agent|install|_app-auth|status|app-auth)(\/|$|\?)/;

function isControllerUrl(input: string | URL): boolean {
  try {
    const url = new URL(String(input), window.location.href);
    // Only our own origin can be a controller; third-party assets (fonts etc.) pass.
    return url.origin === window.location.origin && CONTROLLER_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

let lastToast = 0;
export function notifyDemoBlocked(what = 'That'): void {
  const now = Date.now();
  if (now - lastToast < 3_000) return;
  lastToast = now;
  toast.info(`${what} needs a real swarmy controller. This is a demo: data is fake and nothing is saved.`);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A WebSocket/EventSource stand-in that never connects: closes on the next tick. */
function makeDeadSocket(kind: 'ws' | 'sse', url: string): unknown {
  const t = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(t, {
    url,
    readyState: kind === 'ws' ? 3 : 2,
    protocol: '',
    extensions: '',
    bufferedAmount: 0,
    binaryType: 'blob',
    withCredentials: false,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
  });
  setTimeout(() => {
    const err = new Event('error');
    (t.onerror as ((e: Event) => void) | null)?.(err);
    t.dispatchEvent(err);
    if (kind === 'ws') {
      const close = new CloseEvent('close', { code: 1008, reason: 'demo mode', wasClean: false });
      (t.onclose as ((e: Event) => void) | null)?.(close);
      t.dispatchEvent(close);
    }
  }, 0);
  return t;
}

export function installDemoNetworkGuard(): void {
  if (typeof window === 'undefined' || (window as { __swarmyDemoGuard?: boolean }).__swarmyDemoGuard) return;
  (window as { __swarmyDemoGuard?: boolean }).__swarmyDemoGuard = true;

  const realFetch = window.fetch.bind(window);
  const guardedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isControllerUrl(urlOf(input))) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') notifyDemoBlocked();
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'demo', message: 'This is a demo: there is no controller.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  window.fetch = Object.assign(guardedFetch, { preconnect: () => undefined }) as typeof fetch;

  const RealXHR = window.XMLHttpRequest;
  const realOpen = RealXHR.prototype.open;
  const realSend = RealXHR.prototype.send;
  const blocked = new WeakSet<XMLHttpRequest>();
  RealXHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (isControllerUrl(url)) blocked.add(this);
    return (realOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof RealXHR.prototype.open;
  RealXHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (blocked.has(this)) {
      notifyDemoBlocked();
      setTimeout(() => this.dispatchEvent(new ProgressEvent('error')), 0);
      return;
    }
    return realSend.call(this, body);
  };

  const RealWS = window.WebSocket;
  const GuardedWS = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    if (isControllerUrl(String(url).replace(/^ws/, 'http'))) {
      notifyDemoBlocked('A live connection');
      return makeDeadSocket('ws', String(url));
    }
    return new RealWS(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(GuardedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: RealWS.prototype });
  window.WebSocket = GuardedWS;

  if (window.EventSource) {
    const RealES = window.EventSource;
    const GuardedES = function (this: unknown, url: string | URL, init?: EventSourceInit) {
      if (isControllerUrl(url)) return makeDeadSocket('sse', String(url));
      return new RealES(url, init);
    } as unknown as typeof EventSource;
    Object.assign(GuardedES, { CONNECTING: 0, OPEN: 1, CLOSED: 2, prototype: RealES.prototype });
    window.EventSource = GuardedES;
  }

  if (navigator.sendBeacon) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) =>
      isControllerUrl(url) ? true : realBeacon(url, data);
  }

  // Full-page hops to controller paths (OAuth, /_app-auth/start, /api/v1/docs
  // links) would land on the static host's 404: swallow the click instead.
  document.addEventListener(
    'click',
    (ev) => {
      const a = (ev.target as Element | null)?.closest?.('a[href]');
      if (a && isControllerUrl((a as HTMLAnchorElement).href)) {
        ev.preventDefault();
        notifyDemoBlocked();
      }
    },
    true,
  );
}

if (isDemo()) installDemoNetworkGuard();
