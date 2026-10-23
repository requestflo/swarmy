/**
 * Pure: the error a replay is linked to (from the error-tracking store, by
 * replay id or by one of the visit's traces), said for the card under the
 * player — message, source-mapped frame, the request it broke, its trace.
 */
import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';
import type { ReplayDetail } from './rum-shared';

type IssueEvent = NonNullable<inferOutput<TRPCOptionsProxy<AppRouter>['errors']['issue']>['event']>;

export interface LinkedError {
  fingerprint: string;
  /** Only when it's the store's own id shape (the issue query rejects others). */
  eventId: string | null;
  title: string;
  traceId: string | null;
  tsMs: number | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const EVENT_ID = /^[0-9a-f-]{32,36}$/i;

/** The first tracked error in the visit; null when none is linked. */
export function linkedError(errors: ReplayDetail['errors']): LinkedError | null {
  const e = errors.find((x) => str(x.fingerprint));
  if (!e) return null;
  const eventId = str(e.event_id);
  const ts = Number(e.ts_ms);
  return {
    fingerprint: str(e.fingerprint),
    eventId: EVENT_ID.test(eventId) ? eventId : null,
    title: str(e.title) || [str(e.exc_type), str(e.exc_value)].filter(Boolean).join(': ') || 'Error',
    traceId: str(e.trace_id) || null,
    tsMs: Number.isFinite(ts) ? ts : null,
  };
}

/**
 * The crash frame (last in-app frame of the last exception — Sentry order puts
 * the crash last): "assets/index.js:1 → src/pay.ts:88 (source map)" when a
 * source map resolved it, else just where it threw. Null without frames.
 */
export function frameLine(event: Pick<IssueEvent, 'exceptions'> | null | undefined): string | null {
  const frames = event?.exceptions.at(-1)?.frames ?? [];
  const f = frames.findLast((x) => x.inApp) ?? frames.at(-1);
  if (!f) return null;
  const at = (file: string | null, line: number | null) => `${file ?? '<unknown>'}${line != null ? `:${line}` : ''}`;
  const here = at(f.filename, f.lineno);
  return f.minified ? `${at(f.minified.filename, f.minified.lineno)} → ${here} (source map)` : here;
}

/** "POST /api/checkout 500" — the root span of the error's trace in this visit. */
export function requestLine(requests: ReplayDetail['requests'], traceId: string | null): string | null {
  if (!traceId) return null;
  const spans = requests.filter((r) => r.traceId === traceId);
  const root = spans.find((s) => s.method) ?? spans.sort((a, b) => b.durationMs - a.durationMs)[0];
  if (!root) return null;
  return [root.method, root.path || root.name, root.httpStatus].filter(Boolean).join(' ');
}
