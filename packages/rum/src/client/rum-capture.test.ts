import { afterEach, describe, expect, it } from 'bun:test';
import { rumBundles } from '../build';

/**
 * The shipped rum.js (the real bundle, built as the controller serves it) run
 * against a stubbed page: a failed same-origin fetch/XHR in a recorded
 * session keeps the edge's X-Request-Id (the id only, never a body), and
 * privacy mode never touches fetch at all.
 */

type Custom = { tag: string; payload: Record<string, unknown> };
const g = globalThis as unknown as Record<string, unknown>;
const KEYS = ['window', 'document', 'location', 'navigator', 'sessionStorage', 'history', 'innerWidth', 'XMLHttpRequest', 'fetch', 'CustomEvent', 'dispatchEvent', 'addEventListener', '__swarmy', '__swarmyRecord', 'swarmyConsent'];
const saved = Object.fromEntries(KEYS.map((k) => [k, g[k]]));
afterEach(() => {
  for (const k of KEYS) g[k] = saved[k];
});

class FakeXHR {
  status = 0;
  private done: (() => void)[] = [];
  static next = { status: 503, id: 'xhr-req-0001' };
  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, fn: () => void): void {
    if (type === 'loadend') this.done.push(fn);
  }
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'x-request-id' ? FakeXHR.next.id : null;
  }
  send(): void {
    this.status = FakeXHR.next.status;
    queueMicrotask(() => this.done.forEach((f) => f.call(this)));
  }
}

/** Run rum.js on a stubbed page; returns the custom events the recorder got and the page's own fetch. */
async function page(dataset: Record<string, string>): Promise<{ custom: Custom[]; pageFetch: unknown }> {
  const custom: Custom[] = [];
  Object.assign(g, {
    window: g,
    location: new URL('https://shop.example.com/cart'),
    // webdriver: no pageview beacons (and no flush timers) while the test runs.
    navigator: { webdriver: true, sendBeacon: () => true },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { pushState() {}, replaceState() {} },
    innerWidth: 1280,
    XMLHttpRequest: FakeXHR,
    CustomEvent: class {
      constructor(public type: string) {}
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    __swarmy: undefined,
    __swarmyRecord: () => ({ stop() {}, takeSnapshot() {}, addCustom: (tag: string, payload: Record<string, unknown>) => custom.push({ tag, payload }) }),
    document: {
      currentScript: { dataset, src: 'https://shop.example.com/_swarmy/rum.js', nonce: '', getAttribute: () => null },
      referrer: '',
      visibilityState: 'visible',
      addEventListener() {},
      head: { appendChild() {} },
      createElement: () => ({}),
    },
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const failed = url.includes('fail');
      return new Response('{"card":"4242 4242 4242 4242"}', { status: failed ? 500 : 200, headers: { 'X-Request-Id': failed ? 'req-500-abcdef' : 'req-200-abcdef' } });
    },
  });
  const pageFetch = g.fetch;
  new Function((await rumBundles()).rum)();
  return { custom, pageFetch };
}

const requests = (c: Custom[]) => c.filter((e) => e.tag === 'swarmy.request').map((e) => e.payload);

describe('rum.js keeps the request id of a failed request', () => {
  it('fetch: a 5xx carries its id; a success does not; no body is ever read', async () => {
    const { custom, pageFetch } = await page({ app: 'TOKEN', mode: 'identified', replay: '1' });
    const w = g.window as { fetch: typeof fetch };
    expect(w.fetch).not.toBe(pageFetch); // identified: same-origin fetch is wrapped
    await w.fetch('/api/checkout?fail=1', { method: 'POST', body: '{"pan":"4242"}' });
    await w.fetch('/api/cart');
    const [failed, ok] = requests(custom);
    expect(failed).toMatchObject({ method: 'POST', url: '/api/checkout', status: 500, requestId: 'req-500-abcdef' });
    expect(Object.keys(failed!).sort()).toEqual(['dur', 'method', 'requestId', 'start', 'status', 'traceId', 'url']);
    expect(ok).toMatchObject({ url: '/api/cart', status: 200 });
    expect(ok!.requestId).toBeUndefined();
    expect(JSON.stringify(custom)).not.toContain('4242');
  });

  it('XHR: the same, read from the response header', async () => {
    const { custom } = await page({ app: 'TOKEN', mode: 'identified', replay: '1' });
    const X = g.XMLHttpRequest as typeof FakeXHR;
    const xhr = new X() as unknown as XMLHttpRequest;
    xhr.open('GET', '/api/stock');
    xhr.send();
    await new Promise((r) => setTimeout(r, 0));
    expect(requests(custom)).toEqual([expect.objectContaining({ method: 'GET', url: '/api/stock', status: 503, requestId: 'xhr-req-0001' })]);
  });

  it('privacy mode never patches fetch, so no request (and no id) is ever recorded', async () => {
    const { custom, pageFetch } = await page({ app: 'TOKEN', mode: 'analytics' });
    expect(g.fetch).toBe(pageFetch); // still the page's own fetch
    await (g.window as { fetch: typeof fetch }).fetch('/api/checkout?fail=1');
    expect(requests(custom)).toEqual([]);
  });
});
