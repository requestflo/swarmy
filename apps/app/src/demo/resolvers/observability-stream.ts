import type { LogRowView } from '@swarmy/core';

/**
 * The storefront log stream for the Logs & traces tab (Logs board): the last
 * 20 minutes of lines from web, api, checkout and cdn-edge at staggered
 * 1–4 s intervals, three checkout errors whose trace ids resolve to traces
 * with one slow Stripe call, and a tail that grows a line every 1–3 s.
 */

export interface StreamSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service_name: string;
  span_name: string;
  span_kind: string;
  start_unix_nano: string;
  duration_ms: number;
  status_code: string;
  status_message: string;
}

export interface StreamTraceRow {
  trace_id: string;
  span_id: string;
  service_name: string;
  span_name: string;
  duration_ms: number;
  status_code: string;
  span_count: number;
  start_time: string;
}

const T0 = Date.now();
const MIN = 60_000;
const OK = 'STATUS_CODE_OK';
const ERR = 'STATUS_CODE_ERROR';

/** Seeded PRNG so the story is the same on every load. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(8);
const hexId = (len: number): string => Array.from({ length: len }, () => Math.floor(rand() * 16).toString(16)).join('');
const nano = (ms: number): string => `${Math.round(ms)}000000`;
const stamp = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

const SEV = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const;
type Sev = keyof typeof SEV;

function line(part: string, atMs: number, sev: Sev, body: string, traceId = '', spanId = '', attrs: Record<string, string> = {}): LogRowView {
  return { timestamp: stamp(atMs), ts_nano: nano(atMs), trace_id: traceId, span_id: spanId || hexId(16), severity_text: sev, severity_number: SEV[sev], service_name: part, body, attributes: attrs };
}

/** One checkout request: web → api → checkout → Stripe. `stripeMs` 10000 = the timeout. */
function checkoutTrace(atMs: number, stripeMs: number, failed: boolean): { row: StreamTraceRow; spans: StreamSpan[]; totalMs: number; stripeEnd: number } {
  const tid = hexId(32);
  const ids = Array.from({ length: 7 }, () => hexId(16));
  const charge = 38 + 4 + stripeMs + 8;
  const api = 6 + 14 + 4 + charge + (failed ? 6 : 16);
  const total = api + 10;
  const sp = (i: number, parent: number, part: string, name: string, kind: string, off: number, dur: number, err: boolean, msg = ''): StreamSpan => ({
    trace_id: tid, span_id: ids[i]!, parent_span_id: parent < 0 ? '' : ids[parent]!, service_name: part, span_name: name, span_kind: `SPAN_KIND_${kind}`,
    start_unix_nano: nano(atMs + off), duration_ms: dur, status_code: err ? ERR : OK, status_message: err ? msg : '',
  });
  const spans = [
    sp(0, -1, 'web', 'POST /checkout', 'SERVER', 0, total, failed, 'upstream 502'),
    sp(1, 0, 'api', 'POST /api/checkout', 'SERVER', 5, api, failed, 'charge failed'),
    sp(2, 1, 'api', 'SELECT carts', 'CLIENT', 11, 14, false),
    sp(3, 1, 'checkout', 'POST /charge', 'SERVER', 29, charge, failed, 'payment provider timeout'),
    sp(4, 3, 'checkout', 'tokenize card', 'INTERNAL', 31, 38, false),
    sp(5, 3, 'checkout', 'stripe.paymentIntents.create', 'CLIENT', 73, stripeMs, failed, `timed out after ${stripeMs} ms`),
  ];
  if (!failed) spans.push(sp(6, 1, 'api', 'INSERT orders', 'CLIENT', 29 + charge + 3, 11, false));
  const row: StreamTraceRow = { trace_id: tid, span_id: ids[0]!, service_name: 'web', span_name: 'POST /checkout', duration_ms: total, status_code: failed ? ERR : OK, span_count: spans.length, start_time: stamp(atMs) };
  return { row, spans, totalMs: total, stripeEnd: atMs + 73 + stripeMs };
}

const ERROR_AT = [11 * MIN + 12_000, 6 * MIN + 31_000, 2 * MIN + 4_000];

function buildStory(): { rows: LogRowView[]; traces: StreamTraceRow[]; spans: Record<string, StreamSpan[]> } {
  const rows: LogRowView[] = [];
  const traces: StreamTraceRow[] = [];
  const spans: Record<string, StreamSpan[]> = {};
  let order = 48_190;
  const add = (t: ReturnType<typeof checkoutTrace>): void => {
    traces.push(t.row);
    spans[t.row.trace_id] = t.spans;
  };
  // A checkout every ~70–110 s that goes fine…
  for (let age = 19 * MIN; age > 20_000; age -= 70_000 + rand() * 40_000) {
    if (ERROR_AT.some((e) => Math.abs(e - age) < 25_000)) continue;
    const at = T0 - age;
    const t = checkoutTrace(at, Math.round(180 + rand() * 160), false);
    add(t);
    order += 1;
    rows.push(line('checkout', t.stripeEnd, 'DEBUG', `stripe.paymentIntent created pi_3Q${hexId(6)}`, t.row.trace_id, t.spans[5]!.span_id));
    rows.push(line('checkout', at + t.totalMs, 'INFO', `POST /api/checkout 201 · order #${order} · ${Math.round(t.totalMs)} ms`, t.row.trace_id, t.spans[3]!.span_id, { 'order.id': String(order) }));
  }
  // …and three that time out waiting on Stripe.
  for (const age of ERROR_AT) {
    const at = T0 - age;
    const t = checkoutTrace(at, 10_000, true);
    add(t);
    order += 1;
    rows.push(line('checkout', at + t.totalMs, 'ERROR', `charge failed for order #${order}: stripe.paymentIntents.create timed out after 10000 ms`, t.row.trace_id, t.spans[5]!.span_id, { 'order.id': String(order), 'peer.service': 'api.stripe.com' }));
    rows.push(line('api', at + t.totalMs + 310, 'INFO', `retry scheduled for cart ${hexId(4)} · attempt 2`, t.row.trace_id, t.spans[1]!.span_id));
  }
  // Background chatter, 1–4 s apart.
  for (let at = T0 - 20 * MIN; at < T0; at += 1_000 + rand() * 3_000) rows.push(chatter(at, rand));
  rows.sort((a, b) => Number(BigInt(b.ts_nano) - BigInt(a.ts_nano)));
  return { rows, traces, spans };
}

const CHATTER: Array<[number, string, Sev, (r: () => number) => string]> = [
  [0.16, 'web', 'INFO', (r) => `GET / 200 · ${8 + Math.round(r() * 12)} ms`],
  [0.1, 'web', 'INFO', (r) => `GET /products/${['linen-shirt', 'field-jacket', 'wool-socks', 'canvas-tote'][Math.floor(r() * 4)]} 200 · ${24 + Math.round(r() * 30)} ms`],
  [0.05, 'web', 'DEBUG', (r) => `session refreshed for user u_${48_000 + Math.round(r() * 900)}`],
  [0.14, 'api', 'INFO', (r) => `GET /api/cart 200 · ${30 + Math.round(r() * 30)} ms`],
  [0.1, 'api', 'INFO', (r) => `GET /api/products 200 · ${14 + Math.round(r() * 16)} ms`],
  [0.07, 'api', 'DEBUG', (r) => `SELECT carts WHERE user_id = $1 · ${1 + Math.round(r() * 14)} rows in ${4 + Math.round(r() * 8)} ms`],
  [0.08, 'checkout', 'INFO', (r) => `GET /api/checkout/session 200 · ${12 + Math.round(r() * 14)} ms`],
  [0.04, 'checkout', 'WARN', (r) => `cart_totals took ${320 + Math.round(r() * 160)} ms (budget 250 ms)`],
  [0.03, 'checkout', 'DEBUG', () => 'webhook stripe charge.succeeded verified'],
  [0.13, 'cdn-edge', 'INFO', (r) => `cache HIT /assets/app.js · ${6 + Math.round(r() * 8)} ms`],
  [0.07, 'cdn-edge', 'INFO', (r) => `cache MISS /assets/hero.webp · origin ${38 + Math.round(r() * 30)} ms`],
  [0.02, 'api', 'WARN', (r) => `rate limit at ${78 + Math.round(r() * 12)}% for key live_k1`],
  [0.01, 'web', 'WARN', (r) => `slow render /checkout ${700 + Math.round(r() * 200)} ms (budget 300 ms)`],
];

function chatter(atMs: number, r: () => number): LogRowView {
  let x = r();
  for (const [w, part, sev, body] of CHATTER) {
    if ((x -= w) <= 0) return line(part, atMs, sev, body(r));
  }
  const [, part, sev, body] = CHATTER[0]!;
  return line(part, atMs, sev, body(r));
}

const STORY = buildStory();

/** The checkout traces behind the stream (merged into the demo trace store). */
export const STREAM_TRACES = { traces: STORY.traces, spans: STORY.spans };
/** The seeded storefront lines, newest first. */
export const streamSeedRows = (): LogRowView[] => STORY.rows.slice();
/** Storefront lines are this recent; older demo noise stays clear of the window. */
export const STREAM_WINDOW_MS = 20 * MIN;

/**
 * Grow the tail up to now: one chatter line every 1–3 s since the last one.
 * `rows` is newest first; new lines go on the front. Returns the new "until".
 */
export function tickStream(rows: LogRowView[], untilMs: number): number {
  let at = untilMs;
  const fresh: LogRowView[] = [];
  const now = Date.now();
  for (;;) {
    const next = at + 1_000 + Math.random() * 2_000;
    if (next > now) break;
    at = next;
    fresh.push(chatter(at, Math.random));
  }
  if (fresh.length > 0) rows.unshift(...fresh.reverse());
  return at;
}

export const STREAM_T0 = T0;
