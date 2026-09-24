/**
 * A small synthetic rrweb recording for demo mode: a Northwind shopper goes
 * home → cart → checkout, taps Apple Pay, hits a 500 and rage-clicks. The
 * stream uses rrweb's real wire format (Meta / FullSnapshot / Incremental /
 * Custom) so the dashboard's Replayer plays it like a real session, plus the
 * swarmy.request / swarmy.error / swarmy.navigation custom events rum.js adds.
 */

type SNode = Record<string, unknown> & { id: number };
interface RrEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

const W = 1280;
const H = 760;
const INK = '#1c2340';
const CARD = '#f1ede6';

export interface DemoSpan {
  traceId: string;
  spanId: string;
  service: string;
  name: string;
  startMs: number;
  durationMs: number;
  status: string;
  method: string;
  path: string;
  httpStatus: string;
}

export interface DemoRecording {
  events: RrEvent[];
  requests: DemoSpan[];
  logs: Array<{ tsMs: number; severity: string; service: string; body: string; traceId: string }>;
  errors: Array<Record<string, unknown>>;
  durationMs: number;
  clicks: number;
  errorCount: number;
}

function hex(seed: number, len: number): string {
  let s = seed >>> 0 || 1;
  let out = '';
  while (out.length < len) {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    out += s.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

/** Builds serialized rrweb nodes with ids, remembering the ones clicks target. */
class Page {
  private next = 1;
  readonly refs: Record<string, number> = {};

  el(tag: string, style: string, children: SNode[] = [], ref?: string, attrs: Record<string, string> = {}): SNode {
    const id = this.next++;
    if (ref) this.refs[ref] = id;
    return { type: 2, tagName: tag, attributes: { style, ...attrs }, childNodes: children, id };
  }

  text(s: string): SNode {
    return { type: 3, textContent: s, id: this.next++ };
  }

  doc(title: string, body: SNode[]): SNode {
    const docId = this.next++;
    const dt = { type: 1, name: 'html', publicId: '', systemId: '', id: this.next++ };
    const head = this.el('head', '', [this.el('title', '', [this.text(title)])]);
    const b = this.el(
      'body',
      `margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fbf8f3;color:${INK}`,
      body,
      'body',
    );
    return { type: 0, childNodes: [dt, this.el('html', '', [head, b])], id: docId };
  }
}

function header(p: Page, path: string): SNode {
  return p.el('div', `display:flex;align-items:center;gap:24px;padding:18px 40px;border-bottom:1px solid #e6e0d6`, [
    p.el('b', 'font-size:20px', [p.text('Northwind')]),
    p.el('span', 'opacity:.6;font-size:14px', [p.text('mugs & things')]),
    p.el('span', 'margin-left:auto;font-size:14px', [p.text(path === '/' ? 'Cart (0)' : 'Cart (3)')]),
  ]);
}

function home(p: Page): SNode {
  const items = ['Stoneware mug · £18', 'Espresso cup · £12', 'Pour-over set · £46', 'Tea tin · £9', 'Travel mug · £24', 'Saucer · £7', 'Gift card', 'Sale'];
  return p.doc('Northwind', [
    header(p, '/'),
    p.el('div', 'padding:32px 40px', [
      p.el('h1', 'margin:0 0 20px;font-size:34px', [p.text('Handmade for slow mornings')]),
      p.el(
        'div',
        'display:grid;grid-template-columns:repeat(4,1fr);gap:16px',
        items.map((t, i) =>
          p.el('div', `height:170px;border-radius:14px;background:${CARD};display:flex;align-items:flex-end;padding:14px;font-weight:600`, [p.text(t)], i === 2 ? 'pourover' : i === 0 ? 'mug' : undefined),
        ),
      ),
    ]),
  ]);
}

function cart(p: Page): SNode {
  const line = (name: string, meta: string): SNode =>
    p.el('div', `display:flex;gap:16px;padding:14px;border-radius:12px;background:${CARD};margin-bottom:10px`, [
      p.el('div', 'width:90px;height:70px;border-radius:10px;background:#e3ddd2', []),
      p.el('div', '', [p.el('b', '', [p.text(name)]), p.el('div', 'opacity:.6;font-size:14px', [p.text(meta)])]),
    ]);
  return p.doc('Your cart · Northwind', [
    header(p, '/cart'),
    p.el('div', 'padding:32px 40px;max-width:720px', [
      p.el('h1', 'margin:0 0 20px;font-size:30px', [p.text('Your cart')]),
      line('Pour-over set', '× 1 · £46'),
      line('Stoneware mug', '× 2 · £36'),
      p.el('div', 'display:flex;justify-content:flex-end;align-items:center;gap:16px;margin-top:16px', [
        p.el('b', 'font-size:18px', [p.text('£82.00')]),
        p.el('span', `padding:12px 22px;border-radius:10px;background:${INK};color:white;font-weight:600`, [p.text('Checkout')], 'checkout'),
      ]),
    ]),
  ]);
}

function checkout(p: Page): SNode {
  const field = (masked: string, ref?: string): SNode =>
    p.el('div', 'height:42px;border-radius:9px;border:1px solid #d6cfc3;background:white;display:flex;align-items:center;padding:0 14px;font-family:monospace;color:#6b6f80;margin-bottom:12px', [p.text(masked)], ref);
  return p.doc('Checkout · Northwind', [
    header(p, '/checkout'),
    p.el('div', 'padding:32px 40px;max-width:480px', [
      p.el('h1', 'margin:0 0 20px;font-size:30px', [p.text('Checkout')]),
      field('••••••••••••@••••.com', 'email'),
      field('•••• ••••••••'),
      field('•• ••••••• ••••, ••••••'),
      p.el('div', 'height:48px;border-radius:10px;background:#111;color:white;display:flex;align-items:center;justify-content:center;font-weight:600', [p.text('Pay with Apple Pay')], 'pay'),
      p.el('div', 'margin-top:14px', [], 'slot'),
    ]),
  ]);
}

/** Build one recording. `full` = the checkout-failure story; otherwise a short browse. */
export function buildRecording(startMs: number, seed: number, full: boolean): DemoRecording {
  const events: RrEvent[] = [];
  const requests: DemoSpan[] = [];
  const logs: DemoRecording['logs'] = [];
  const errors: DemoRecording['errors'] = [];
  let clicks = 0;
  let errorCount = 0;
  let page = new Page();
  const at = (s: number): number => startMs + Math.round(s * 1000);
  const push = (s: number, type: number, data: Record<string, unknown>): void => {
    events.push({ type, timestamp: at(s), data });
  };
  const load = (s: number, path: string, build: (p: Page) => SNode): void => {
    page = new Page();
    const node = build(page);
    push(s, 4, { href: `https://shop.northwind.dev${path}`, width: W, height: H });
    push(s + 0.01, 2, { node, initialOffset: { left: 0, top: 0 } });
  };
  const move = (s: number, x: number, y: number): void =>
    push(s, 3, { source: 1, positions: [{ x, y, id: page.refs.body ?? 1, timeOffset: 0 }] });
  const click = (s: number, ref: string, x: number, y: number): void => {
    move(s - 0.4, x, y);
    push(s, 3, { source: 2, type: 2, id: page.refs[ref] ?? page.refs.body ?? 1, x, y });
    clicks++;
  };
  let n = 0;
  const request = (s: number, method: string, path: string, status: number, dur: number, services: string[]): string => {
    const traceId = hex(seed * 131 + ++n, 32);
    push(s, 5, { tag: 'swarmy.request', payload: { method, url: `https://shop.northwind.dev${path}`, status, start: s * 1000, dur, traceId } });
    let t = at(s);
    services.forEach((svc, i) => {
      const d = Math.max(3, Math.round(dur * (1 - i * 0.3)));
      requests.push({
        traceId,
        spanId: hex(seed * 977 + n * 13 + i, 16),
        service: svc,
        name: i === 0 ? `${method} ${path}` : svc === 'postgres' ? 'SELECT cart_items' : `${svc} ${path}`,
        startMs: t,
        durationMs: d,
        status: status >= 500 && i < 2 ? 'Error' : 'Ok',
        method: i === 0 ? method : '',
        path: i === 0 ? path : '',
        httpStatus: i === 0 ? String(status) : '',
      });
      t += 2;
    });
    return traceId;
  };
  const nav = (s: number, path: string): void => {
    const traceId = request(s, 'GET', path, 200, 40 + (n % 3) * 12, ['web', 'api']);
    push(s + 0.02, 5, { tag: 'swarmy.navigation', payload: { url: `https://shop.northwind.dev${path}`, traceId } });
  };

  load(0, '/', home);
  nav(0.05, '/');
  move(2, 400, 300);
  click(6, 'pourover', 760, 330);
  request(9, 'POST', '/api/cart', 201, 38, ['web', 'api', 'postgres']);
  click(14, 'mug', 180, 330);
  request(16, 'POST', '/api/cart', 201, 35, ['web', 'api', 'postgres']);
  load(22, '/cart', cart);
  nav(22.05, '/cart');
  move(28, 900, 360);
  click(31, 'checkout', 1070, 380);
  if (!full) {
    move(36, 700, 200);
    push(40, 3, { source: 1, positions: [{ x: 640, y: 220, id: page.refs.body ?? 1, timeOffset: 0 }] });
    return { events, requests, logs, errors, durationMs: 40_000, clicks, errorCount };
  }
  load(34, '/checkout', checkout);
  const coTrace = request(34.05, 'GET', '/checkout', 200, 64, ['web', 'api', 'postgres']);
  push(34.07, 5, { tag: 'swarmy.navigation', payload: { url: 'https://shop.northwind.dev/checkout', traceId: coTrace } });
  logs.push({ tsMs: at(34.2), severity: 'INFO', service: 'checkout', body: 'session loaded cart £82.00 (3 items)', traceId: coTrace });
  request(35, 'GET', '/api/shipping/rates', 200, 118, ['web', 'api']);
  click(48, 'email', 240, 190);
  click(66, 'pay', 240, 330);
  const payTrace = request(68, 'POST', '/api/checkout', 500, 1800, ['web', 'checkout', 'stripe']);
  logs.push({ tsMs: at(68.3), severity: 'INFO', service: 'checkout', body: 'creating payment intent', traceId: payTrace });
  logs.push({ tsMs: at(70), severity: 'ERROR', service: 'checkout', body: 'apple pay merchant validation failed: certificate expired', traceId: payTrace });
  push(71, 5, { tag: 'swarmy.error', payload: { message: 'TypeError: applePaySession is undefined', source: 'pay.ts:88' } });
  errorCount++;
  const slot = page.refs.slot ?? 1;
  push(71.05, 3, {
    source: 0,
    texts: [],
    attributes: [],
    removes: [],
    adds: [
      {
        parentId: slot,
        nextId: null,
        node: { type: 2, tagName: 'div', attributes: { style: 'padding:12px 14px;border-radius:9px;background:#fbe3e1;color:#a3242a;font-weight:600' }, childNodes: [], id: 900 },
      },
      { parentId: 900, nextId: null, node: { type: 3, textContent: 'Something went wrong. Please try again.', id: 901 } },
    ],
  });
  errors.push({
    event_id: hex(seed + 5, 32),
    fingerprint: hex(seed + 7, 32),
    ts_ms: at(70.2),
    level: 'error',
    exc_type: 'MerchantValidationError',
    exc_value: 'certificate expired',
    title: 'MerchantValidationError: certificate expired',
    culprit: 'validateMerchant(src/pay/apple.ts)',
    trace_id: payTrace,
    release: 'v119',
  });
  errorCount++;
  click(74, 'pay', 244, 332);
  click(75, 'pay', 238, 329);
  click(76, 'pay', 241, 331);
  request(76.2, 'POST', '/api/checkout', 500, 1700, ['web', 'checkout']);
  logs.push({ tsMs: at(76.5), severity: 'WARN', service: 'api', body: 'POST /api/checkout 500 retried by client', traceId: '' });
  load(88, '/cart', cart);
  nav(88.05, '/cart');
  move(94, 640, 300);
  return { events, requests, logs, errors, durationMs: 94_000, clicks, errorCount };
}
