import type { Tone } from '@/components/calm';

/** The span fields the waterfall needs (a subset of `observability.traceDetail`'s rows). */
export interface WaterfallSpan {
  span_id: string;
  parent_span_id: string;
  service_name: string;
  span_name: string;
  start_unix_nano: string;
  duration_ms: number;
  status_code: string;
  status_message: string;
}

export interface WaterfallBar {
  span: WaterfallSpan;
  depth: number;
  /** Start and width as a percentage of the trace. */
  leftPct: number;
  widthPct: number;
  /** Time spent in this span and not in its children. */
  selfMs: number;
  tone: Tone;
}

export interface WaterfallLayout {
  bars: WaterfallBar[];
  totalMs: number;
  /** Axis marks in ms, 0 … total. */
  ticks: number[];
  parts: number;
  /** The span that ate the most of the request, when it ate a big share. */
  culprit: { span: WaterfallSpan; selfMs: number; share: number } | null;
}

const failed = (s: WaterfallSpan): boolean => s.status_code.toUpperCase().includes('ERROR');
/** A span that owns this share of the whole request is called out as the slow one. */
export const SLOW_SHARE = 0.4;

/**
 * Lay a trace out as a waterfall: depth-first by parent, offsets from the
 * earliest start, each bar's self time, and tones — the failing leaf span
 * `bad`, the span holding most of the time `warn`, the root `idle`, the rest
 * `info`.
 */
export function layoutWaterfall(spans: WaterfallSpan[]): WaterfallLayout {
  if (spans.length === 0) return { bars: [], totalMs: 0, ticks: [0], parts: 0, culprit: null };
  const startMs = (s: WaterfallSpan): number => Number(BigInt(s.start_unix_nano) / 1000n) / 1000;
  const t0 = Math.min(...spans.map(startMs));
  const totalMs = Math.max(Math.max(...spans.map((s) => startMs(s) + s.duration_ms)) - t0, 0.001);

  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const kids = new Map<string, WaterfallSpan[]>();
  for (const s of spans) {
    const p = byId.has(s.parent_span_id) ? s.parent_span_id : '';
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  for (const list of kids.values()) list.sort((a, b) => startMs(a) - startMs(b));

  const selfOf = (s: WaterfallSpan): number => {
    const childMs = (kids.get(s.span_id) ?? []).reduce((a, c) => a + c.duration_ms, 0);
    return Math.max(0, s.duration_ms - childMs);
  };
  const failsBelow = (s: WaterfallSpan): boolean => (kids.get(s.span_id) ?? []).some((c) => failed(c) || failsBelow(c));

  const ordered: Array<{ span: WaterfallSpan; depth: number }> = [];
  const walk = (parent: string, depth: number): void => {
    for (const span of kids.get(parent) ?? []) {
      ordered.push({ span, depth });
      walk(span.span_id, depth + 1);
    }
  };
  walk('', 0);

  const candidates = ordered.filter(({ depth }) => depth > 0 || ordered.length === 1).map(({ span }) => ({ span, selfMs: selfOf(span), share: selfOf(span) / totalMs }));
  const top = candidates.reduce<(typeof candidates)[number] | null>((best, c) => (!best || c.selfMs > best.selfMs ? c : best), null);
  const culprit: WaterfallLayout['culprit'] = top && top.share >= SLOW_SHARE ? top : null;

  const bars = ordered.map(({ span, depth }): WaterfallBar => {
    const leftPct = ((startMs(span) - t0) / totalMs) * 100;
    const widthPct = Math.max((span.duration_ms / totalMs) * 100, 0.4);
    const tone: Tone =
      failed(span) && !failsBelow(span) ? 'bad' : culprit?.span.span_id === span.span_id ? 'warn' : depth === 0 ? 'idle' : 'info';
    return { span, depth, leftPct, widthPct: Math.min(widthPct, 100 - leftPct), selfMs: selfOf(span), tone };
  });

  return { bars, totalMs, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * totalMs)), parts: new Set(spans.map((s) => s.service_name)).size, culprit };
}

/** `142 ms`, `1.3 s`, `10 s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)} s`;
}
