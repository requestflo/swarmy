/**
 * rum.js — swarmy's real-user-monitoring script, injected by the edge
 * (swarmy_rum Caddy module) as `<script src="/_swarmy/rum.js" data-…>`.
 * Everything it talks to is same-origin (`/_swarmy/*`).
 *
 * PRIVACY MODE (data-mode="analytics", the default): pageviews, referrer,
 * UTM, viewport class and engaged time. No cookies, no storage, no ids —
 * nothing is written to or read from the device beyond what the page itself
 * exposes. Unique visitors are counted server-side from a daily-rotating hash.
 *
 * IDENTIFIED MODE (data-mode="identified"): once consent is given (or when
 * consent is set to none), a session id in sessionStorage, the same-origin
 * request headers that link server traces (Swarmy-Session + a traceparent the
 * page did not set itself), and — for a sampled share of sessions — the
 * rrweb recorder (/_swarmy/replay.js) with every input masked.
 *
 * Consent (data-consent): "hook" waits for `window.swarmyConsent(true)` (or
 * `{ replay: true }`); "cmp" additionally listens to an IAB TCF v2 CMP
 * (purposes 1 + 8); "none" starts straight away (internal tools only).
 */

interface SwarmyRecordOptions {
  emit: (e: unknown) => void;
  maskAllText: boolean;
  blockSelector: string;
}
interface SwarmyRecorder {
  stop(): void;
  addCustom(tag: string, payload: unknown): void;
  takeSnapshot(): void;
}
interface SwarmyGlobal {
  sessionId: string | null;
  mode: string;
  replaying: boolean;
  replayId(): string | null;
  track(name: string): void;
  consent(given: boolean | { replay?: boolean; analytics?: boolean }): void;
}
declare global {
  interface Window {
    __swarmy?: SwarmyGlobal;
    __swarmyRecord?: (o: SwarmyRecordOptions) => SwarmyRecorder;
    swarmyConsent?: (given: boolean | { replay?: boolean }) => void;
    Sentry?: { setTag?: (k: string, v: string) => void; setContext?: (k: string, v: Record<string, unknown>) => void };
    __tcfapi?: (cmd: string, v: number, cb: (data: TcfData, ok: boolean) => void) => void;
  }
}
interface TcfData {
  eventStatus?: string;
  gdprApplies?: boolean;
  purpose?: { consents?: Record<string, boolean> };
}

(function main() {
  if (window.__swarmy) return; // injected twice (e.g. an iframe of the same app) — first wins
  const script = document.currentScript as HTMLScriptElement | null;
  const ds = script?.dataset ?? {};
  const app = ds.app ?? '';
  if (!app) return;
  const mode = ds.mode === 'identified' ? 'identified' : 'analytics';
  const replayRate = Math.min(1, Math.max(0, Number(ds.replay ?? 0) || 0));
  const consentMode = ds.consent === 'cmp' ? 'cmp' : ds.consent === 'hook' ? 'hook' : 'none';
  const maskAll = ds.mask === 'all';
  const blockSelector = ['[data-swarmy-block]', '.swarmy-block', ...(ds.block ? [ds.block] : [])].join(',');
  const nonce = script?.nonce || script?.getAttribute('nonce') || '';
  const base = (script?.src ? new URL(script.src, location.href).pathname : '/_swarmy/rum.js').replace(/\/rum\.js$/, '');
  const ingest = `${base}/rum?app=${encodeURIComponent(app)}`;
  const nav = navigator as Navigator & { webdriver?: boolean };

  // ── transport ─────────────────────────────────────────────────────
  type Ev = { t: 'pv' | 'ev' | 'lv'; u: string; r?: string; n?: string; w?: number; d?: number; ts: number; sid?: string };
  let queue: Ev[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  function send(body: string, beacon: boolean): void {
    try {
      if (beacon && navigator.sendBeacon && navigator.sendBeacon(ingest, new Blob([body], { type: 'text/plain' }))) return;
      void fetch(ingest, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    } catch {
      /* never break the page */
    }
  }
  function flush(beacon = false): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (queue.length === 0) return;
    const batch = queue.splice(0, 50);
    send(JSON.stringify({ v: 1, e: batch }), beacon);
    if (queue.length) flush(beacon);
  }
  function push(e: Omit<Ev, 'ts' | 'w' | 'sid'>): void {
    if (nav.webdriver && !ds.allowAutomation) return; // automation is not an audience
    queue.push({ ...e, ts: Date.now(), w: window.innerWidth || undefined, sid: sessionId ?? undefined });
    if (queue.length >= 20) flush();
    else if (!timer) timer = setTimeout(() => flush(), 2000);
  }

  // ── identified: session, consent, trace linking ─────────────────────
  let sessionId: string | null = null;
  let consented = consentMode === 'none';
  let replayConsented = consented;
  let recorder: SwarmyRecorder | null = null;

  function newId(): string {
    const t = Date.now().toString(36).padStart(9, '0');
    const r = new Uint8Array(10);
    crypto.getRandomValues(r);
    return t + Array.from(r, (b) => (b % 36).toString(36)).join('');
  }
  const SID_KEY = 'swarmy.sid';
  const IDLE_MS = 30 * 60 * 1000;
  function loadSession(): string {
    try {
      const raw = sessionStorage.getItem(SID_KEY);
      if (raw) {
        const [id, last, sampled] = raw.split('|');
        if (id && Date.now() - Number(last) < IDLE_MS) {
          sampledReplay = sampled === '1';
          return id;
        }
      }
    } catch {
      /* storage blocked: session lives in memory only */
    }
    sampledReplay = Math.random() < replayRate;
    return newId();
  }
  let sampledReplay = false;
  function touch(): void {
    if (!sessionId) return;
    try {
      sessionStorage.setItem(SID_KEY, `${sessionId}|${Date.now()}|${sampledReplay ? 1 : 0}`);
    } catch {
      /* ignore */
    }
  }

  function hex(n: number): string {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function sameOrigin(url: string): boolean {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }
  function pathOf(url: string): string {
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return url.slice(0, 200);
    }
  }
  function recordRequest(p: { method: string; url: string; status: number; start: number; dur: number; traceId: string }): void {
    recorder?.addCustom('swarmy.request', { ...p, url: pathOf(p.url) });
  }

  function patchNetwork(): void {
    const origFetch = window.fetch;
    const swarmyFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!sessionId || !sameOrigin(url) || pathOf(url).startsWith(`${base}/`)) return origFetch.call(this, input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('Swarmy-Session', sessionId);
      let traceId = '';
      const tp = headers.get('traceparent');
      if (tp) traceId = tp.split('-')[1] ?? '';
      else {
        traceId = hex(16);
        headers.set('traceparent', `00-${traceId}-${hex(8)}-01`);
      }
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const start = Date.now();
      const req = input instanceof Request ? new Request(input, { ...init, headers }) : undefined;
      const p = req ? origFetch.call(this, req) : origFetch.call(this, input, { ...init, headers });
      return p.then(
        (res) => {
          recordRequest({ method, url, status: res.status, start, dur: Date.now() - start, traceId });
          return res;
        },
        (err: unknown) => {
          recordRequest({ method, url, status: 0, start, dur: Date.now() - start, traceId });
          throw err;
        },
      );
    };
    window.fetch = swarmyFetch as typeof fetch;
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    const XH = XMLHttpRequest.prototype.setRequestHeader;
    type X = XMLHttpRequest & { __sw?: { method: string; url: string; tp?: boolean } };
    XMLHttpRequest.prototype.open = function (this: X, method: string, url: string | URL, ...rest: unknown[]) {
      this.__sw = { method: String(method).toUpperCase(), url: String(url) };
      return (XO as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.setRequestHeader = function (this: X, k: string, v: string) {
      if (this.__sw && k.toLowerCase() === 'traceparent') this.__sw.tp = true;
      return XH.call(this, k, v);
    };
    XMLHttpRequest.prototype.send = function (this: X, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = this.__sw;
      if (m && sessionId && sameOrigin(m.url) && !pathOf(m.url).startsWith(`${base}/`)) {
        const traceId = m.tp ? '' : hex(16);
        try {
          XH.call(this, 'Swarmy-Session', sessionId);
          if (traceId) XH.call(this, 'traceparent', `00-${traceId}-${hex(8)}-01`);
        } catch {
          /* already sent */
        }
        const start = Date.now();
        this.addEventListener('loadend', () =>
          recordRequest({ method: m.method, url: m.url, status: this.status, start, dur: Date.now() - start, traceId }),
        );
      }
      return XS.call(this, body);
    };
  }

  function navigationTrace(): string {
    try {
      const nt = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const st = nt?.serverTiming?.find((s) => s.name === 'traceparent');
      return st?.description?.split('-')[1] ?? '';
    } catch {
      return '';
    }
  }

  function startReplay(): void {
    if (recorder || !sampledReplay || !replayConsented || !sessionId) return;
    const go = () => {
      if (!window.__swarmyRecord || recorder) return;
      let seq = 0;
      let buf: unknown[] = [];
      let bytes = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const sid = sessionId!;
      const url = () => `${base}/replay?app=${encodeURIComponent(app)}&sid=${sid}&seq=${seq}`;
      const flushReplay = (beacon = false) => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (!buf.length) return;
        const body = JSON.stringify({ v: 1, events: buf });
        const target = url();
        seq++;
        buf = [];
        bytes = 0;
        try {
          if (beacon && body.length < 60000 && navigator.sendBeacon?.(target, new Blob([body], { type: 'text/plain' }))) return;
          void fetch(target, { method: 'POST', body, keepalive: body.length < 60000, credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
        } catch {
          /* ignore */
        }
      };
      recorder = window.__swarmyRecord({
        emit(e) {
          buf.push(e);
          bytes += 200;
          if (buf.length >= 400 || bytes > 400_000) flushReplay();
          else if (!flushTimer) flushTimer = setTimeout(() => flushReplay(), 5000);
        },
        maskAllText: maskAll,
        blockSelector,
      });
      g.replaying = true;
      const nt = navigationTrace();
      recorder.addCustom('swarmy.navigation', { url: location.pathname, traceId: nt });
      addEventListener('pagehide', () => flushReplay(true));
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushReplay(true));
      dispatchEvent(new CustomEvent('swarmy:session', { detail: { sessionId: sid, replaying: true } }));
    };
    if (window.__swarmyRecord) go();
    else {
      const s = document.createElement('script');
      s.src = `${base}/replay.js`;
      s.async = true;
      if (nonce) s.nonce = nonce;
      s.onload = go;
      document.head.appendChild(s);
    }
  }

  function startIdentified(): void {
    if (sessionId) return;
    sessionId = loadSession();
    touch();
    g.sessionId = sessionId;
    patchNetwork();
    try {
      window.Sentry?.setTag?.('swarmy.replay_id', sessionId);
      window.Sentry?.setContext?.('swarmy', { replay_id: sessionId });
    } catch {
      /* ignore */
    }
    addEventListener('error', (e: ErrorEvent) => recorder?.addCustom('swarmy.error', { message: String(e.message).slice(0, 500), source: e.filename, line: e.lineno }));
    addEventListener('unhandledrejection', (e: PromiseRejectionEvent) =>
      recorder?.addCustom('swarmy.error', { message: String((e.reason as Error)?.message ?? e.reason).slice(0, 500), kind: 'unhandledrejection' }),
    );
    dispatchEvent(new CustomEvent('swarmy:session', { detail: { sessionId, replaying: false } }));
    startReplay();
  }

  function consent(given: boolean | { replay?: boolean; analytics?: boolean }): void {
    const replay = typeof given === 'boolean' ? given : given.replay !== false;
    const analytics = typeof given === 'boolean' ? given : given.analytics !== false || replay;
    if (mode !== 'identified') return;
    if (!analytics) {
      consented = false;
      replayConsented = false;
      recorder?.stop();
      recorder = null;
      g.replaying = false;
      try {
        sessionStorage.removeItem(SID_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    consented = true;
    replayConsented = replay;
    startIdentified();
    if (replay) startReplay();
  }

  // ── public surface ───────────────────────────────────────────────
  const g: SwarmyGlobal = {
    sessionId: null,
    mode,
    replaying: false,
    replayId: () => (g.replaying ? sessionId : null),
    track: (name: string) => push({ t: 'ev', u: location.href, n: String(name).slice(0, 80) }),
    consent,
  };
  window.__swarmy = g;
  window.swarmyConsent = consent;

  if (mode === 'identified') {
    if (consented) startIdentified();
    if (consentMode === 'cmp' && typeof window.__tcfapi === 'function') {
      window.__tcfapi('addEventListener', 2, (d, ok) => {
        if (!ok || (d.eventStatus !== 'tcloaded' && d.eventStatus !== 'useractioncomplete')) return;
        const c = d.purpose?.consents ?? {};
        consent({ analytics: Boolean(c['1'] && c['8']), replay: Boolean(c['1'] && c['8']) });
      });
    }
  }

  // ── pageviews (both modes) + SPA navigation + engaged time ───────
  let lastUrl = '';
  let shownAt = Date.now();
  let engaged = 0;
  function pageview(): void {
    const href = location.href.split('#')[0]!;
    if (href === lastUrl) return;
    if (lastUrl) leave();
    const ref = lastUrl || document.referrer;
    lastUrl = href;
    shownAt = Date.now();
    engaged = 0;
    push({ t: 'pv', u: href, r: ref });
    touch();
    recorder?.addCustom('swarmy.navigation', { url: location.pathname, traceId: '' });
  }
  function leave(): void {
    if (document.visibilityState === 'visible') engaged += Date.now() - shownAt;
    if (engaged > 0) push({ t: 'lv', u: lastUrl, d: engaged });
    engaged = 0;
    shownAt = Date.now();
  }
  for (const k of ['pushState', 'replaceState'] as const) {
    const orig = history[k];
    history[k] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args);
      setTimeout(pageview, 0);
      return r;
    } as History['pushState'];
  }
  addEventListener('popstate', () => setTimeout(pageview, 0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      leave();
      flush(true);
    } else shownAt = Date.now();
  });
  addEventListener('pagehide', () => {
    leave();
    flush(true);
  });
  pageview();
})();

export {};
