/**
 * A Sentry event payload → the flat record swarmy stores (pure).
 *
 * Only the fields the Issues UI, grouping and linking need are lifted into
 * columns; the whole (trimmed) event rides along as `payload` so the issue
 * detail can render everything the SDK sent (breadcrumbs, contexts, request).
 */

export interface SentryFrame {
  filename?: string | null;
  abs_path?: string | null;
  module?: string | null;
  function?: string | null;
  lineno?: number | null;
  colno?: number | null;
  in_app?: boolean | null;
  context_line?: string | null;
  pre_context?: string[] | null;
  post_context?: string[] | null;
  platform?: string | null;
  /** Set by swarmy when a source map resolved this frame. */
  data?: { sourcemap?: string; symbolicated?: boolean; minified?: MinifiedPosition } | null;
}

export interface MinifiedPosition {
  filename: string | null;
  function: string | null;
  lineno: number | null;
  colno: number | null;
}

export interface SentryException {
  type?: string | null;
  value?: string | null;
  module?: string | null;
  mechanism?: { type?: string; handled?: boolean; synthetic?: boolean } | null;
  stacktrace?: { frames?: SentryFrame[] | null } | null;
}

export interface SentryBreadcrumb {
  timestamp?: number | string;
  type?: string;
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface NormalizedEvent {
  eventId: string;
  /** Epoch milliseconds (event time, SDK clock). */
  timestamp: number;
  level: string;
  platform: string;
  excType: string;
  excValue: string;
  message: string;
  title: string;
  culprit: string;
  transaction: string;
  release: string;
  environment: string;
  serverName: string;
  userId: string;
  userEmail: string;
  userIp: string;
  /** Stable "who" for users-affected counts: id → email → username → ip. */
  userKey: string;
  traceId: string;
  spanId: string;
  /** Session replay link (plans/epic-developer-platform.md §5). Empty until replay ships. */
  replayId: string;
  sdkName: string;
  sdkVersion: string;
  handled: boolean;
  tags: Record<string, string>;
  exceptions: SentryException[];
  breadcrumbs: SentryBreadcrumb[];
  /** The SDK-provided fingerprint, if any (`["{{ default }}", "checkout"]`). */
  fingerprint: string[] | null;
  /** Debug IDs the SDK attached (`debug_meta.images[type=sourcemap]`): code_file → debug_id. */
  debugIds: Record<string, string>;
  /** The event as received (minus bulky, never-rendered fields). */
  raw: Record<string, unknown>;
}

const str = (v: unknown, max = 1024): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Sentry timestamps are either epoch seconds (float) or RFC 3339 strings. */
export function parseTimestamp(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v > 1e12 ? v : v * 1000);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return Math.round(n > 1e12 ? n : n * 1000);
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

/** `exception` is `{ values: [...] }` or (old SDKs) a bare array. Oldest cause first, like Sentry. */
export function exceptionValues(event: Record<string, unknown>): SentryException[] {
  const ex = event.exception;
  const list = Array.isArray(ex) ? ex : Array.isArray(asObj(ex).values) ? (asObj(ex).values as unknown[]) : [];
  return list.filter((e): e is SentryException => !!e && typeof e === 'object');
}

/** Tags arrive as `{k: v}` or `[[k, v], …]`. Values are stringified; keys capped. */
export function normalizeTags(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: unknown, val: unknown) => {
    if (typeof k !== 'string' || !k) return;
    if (Object.keys(out).length >= 50) return;
    out[k.slice(0, 64)] = typeof val === 'string' ? val.slice(0, 200) : JSON.stringify(val ?? '').slice(0, 200);
  };
  if (Array.isArray(v)) for (const pair of v) Array.isArray(pair) && put(pair[0], pair[1]);
  else for (const [k, val] of Object.entries(asObj(v))) put(k, val);
  return out;
}

function breadcrumbList(v: unknown): SentryBreadcrumb[] {
  const list = Array.isArray(v) ? v : Array.isArray(asObj(v).values) ? (asObj(v).values as unknown[]) : [];
  return list.filter((b): b is SentryBreadcrumb => !!b && typeof b === 'object').slice(-100);
}

/** The function names SDKs use for "anonymous". */
const ANON_FN = new Set(['?', '<anonymous>', 'anonymous', '<unknown>', '']);

/** The in-app frame nearest the crash (last in Sentry order), else the last frame. */
export function culpritFrame(exceptions: SentryException[]): SentryFrame | null {
  const last = exceptions[exceptions.length - 1];
  const frames = last?.stacktrace?.frames ?? [];
  for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i]?.in_app) return frames[i]!;
  return frames[frames.length - 1] ?? null;
}

/** "priceOf(src/checkout.js)" — Sentry's culprit shape. */
export function frameCulprit(f: SentryFrame | null): string {
  if (!f) return '';
  const fn = f.function && !ANON_FN.has(f.function) ? f.function : '?';
  const where = f.module || f.filename || f.abs_path || '';
  return where ? `${fn}(${where})` : fn;
}

/** Sentry's issue title: `Type: value` for errors, the message otherwise. */
export function eventTitle(e: Pick<NormalizedEvent, 'exceptions' | 'message'>): string {
  const last = e.exceptions[e.exceptions.length - 1];
  if (last) {
    const synthetic = last.mechanism?.synthetic === true;
    const type = synthetic ? '' : str(last.type, 200);
    const value = str(last.value, 300).split('\n')[0] ?? '';
    if (type && value) return `${type}: ${value}`;
    if (type || value) return type || value;
  }
  return (e.message.split('\n')[0] ?? '').slice(0, 300) || '<unlabeled event>';
}

function messageOf(event: Record<string, unknown>): string {
  const le = asObj(event.logentry);
  const m = event.message;
  if (typeof le.formatted === 'string') return le.formatted;
  if (typeof le.message === 'string') return le.message;
  if (typeof m === 'string') return m;
  const mo = asObj(m);
  return str(mo.formatted) || str(mo.message);
}

/** Template of the message (for grouping): `logentry.message` beats the formatted text. */
export function messageTemplate(event: Record<string, unknown>): string {
  const le = asObj(event.logentry);
  if (typeof le.message === 'string') return le.message;
  const mo = asObj(event.message);
  if (typeof mo.message === 'string') return mo.message;
  return messageOf(event);
}

/** Normalise one event. `now` fills a missing timestamp; `eventId` a missing id. */
export function normalizeEvent(
  event: Record<string, unknown>,
  opts: { now: number; eventId?: string; envelopeHeader?: Record<string, unknown> },
): NormalizedEvent {
  const contexts = asObj(event.contexts);
  const trace = asObj(contexts.trace);
  const replay = asObj(contexts.replay);
  const user = asObj(event.user);
  const sdk = asObj(event.sdk);
  const tags = normalizeTags(event.tags);
  const exceptions = exceptionValues(event);
  const last = exceptions[exceptions.length - 1];
  const message = messageOf(event);
  const debugIds: Record<string, string> = {};
  const images = asObj(event.debug_meta).images;
  if (Array.isArray(images)) {
    for (const img of images) {
      const i = asObj(img);
      if ((i.type === 'sourcemap' || i.type === undefined) && typeof i.code_file === 'string' && typeof i.debug_id === 'string') {
        debugIds[i.code_file] = i.debug_id.toLowerCase();
      }
    }
  }

  const eventId = (str(event.event_id, 64) || opts.eventId || str(opts.envelopeHeader?.event_id, 64) || '').replace(/-/g, '').toLowerCase();
  const userId = str(user.id, 200);
  const userEmail = str(user.email, 200);
  const userIp = str(user.ip_address, 64);
  const culprit = str(event.culprit, 300) || str(event.transaction, 300) || frameCulprit(culpritFrame(exceptions));
  // swarmy's own recorder (rum.js) tags `swarmy.replay_id` and sets
  // `contexts.swarmy.replay_id`; Sentry's Replay SDK uses `contexts.replay`.
  const replayId = (
    tags['swarmy.replay_id'] ||
    str(asObj(contexts.swarmy).replay_id, 64) ||
    str(replay.replay_id, 64) ||
    tags.replayId ||
    ''
  ).slice(0, 64);

  const raw: Record<string, unknown> = { ...event };
  delete raw.modules; // the dependency list is huge and never rendered
  if (raw.sdk) raw.sdk = { name: sdk.name, version: sdk.version };

  const normalized: NormalizedEvent = {
    eventId,
    timestamp: parseTimestamp(event.timestamp, opts.now),
    level: str(event.level, 16) || 'error',
    platform: str(event.platform, 32) || 'other',
    excType: last && last.mechanism?.synthetic !== true ? str(last.type, 200) : '',
    excValue: last ? str(last.value, 2000) : '',
    message,
    title: '',
    culprit,
    transaction: str(event.transaction, 300),
    release: str(event.release, 200),
    environment: str(event.environment, 64) || 'production',
    serverName: str(event.server_name, 200),
    userId,
    userEmail,
    userIp,
    userKey: userId ? `id:${userId}` : userEmail ? `email:${userEmail}` : str(user.username) ? `u:${str(user.username)}` : userIp ? `ip:${userIp}` : '',
    traceId: str(trace.trace_id, 64).replace(/-/g, '').toLowerCase(),
    spanId: str(trace.span_id, 32).toLowerCase(),
    replayId,
    sdkName: str(sdk.name, 64),
    sdkVersion: str(sdk.version, 32),
    handled: last?.mechanism?.handled !== false,
    tags,
    exceptions,
    breadcrumbs: breadcrumbList(event.breadcrumbs),
    fingerprint: Array.isArray(event.fingerprint)
      ? event.fingerprint.filter((x): x is string => typeof x === 'string').slice(0, 20)
      : null,
    debugIds,
    raw,
  };
  normalized.title = eventTitle(normalized);
  return normalized;
}
