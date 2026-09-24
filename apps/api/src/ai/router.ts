/**
 * Fallbacks, retries with backoff, and target health for one gateway call.
 *
 * Per target: retry retryable failures (429, 408, 5xx, network/timeout) up to
 * `retries` times with exponential backoff + jitter (a provider's
 * `retry-after` wins, capped). Then fall through to the next target. A
 * client error (400/413/422) stops the whole chain — another provider would
 * reject the same request. Auth/not-found failures (401/403/404) skip to the
 * next target without retrying: that target is misconfigured, not busy.
 *
 * Health: a target that failed `tripAfter` times in a row is cooled for
 * `cooldownMs`; cooled targets move to the back of the order (never removed,
 * so a fully-cooled route still tries everything).
 */

export interface AttemptOk<T> {
  ok: true;
  value: T;
}
export interface AttemptFail {
  ok: false;
  /** Upstream HTTP status, or null for a network/timeout failure. */
  status: number | null;
  error: string;
  retryAfterMs?: number;
}
export type AttemptResult<T> = AttemptOk<T> | AttemptFail;

export type FailureClass = 'retry' | 'next' | 'stop';

export function classifyFailure(status: number | null): FailureClass {
  if (status === null) return 'retry';
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return 'retry';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'next';
  return 'stop';
}

/** `retry-after` seconds or HTTP date → ms (null when absent/garbage). */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 2, baseDelayMs: 250, maxDelayMs: 4000 };

export function backoffMs(attempt: number, o: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'rand'>, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, o.maxDelayMs);
  const exp = o.baseDelayMs * 2 ** attempt;
  const jitter = (o.rand ?? Math.random)() * o.baseDelayMs;
  return Math.min(exp + jitter, o.maxDelayMs);
}

export class TargetHealth {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(
    private readonly tripAfter = 3,
    private readonly cooldownMs = 30_000,
  ) {}
  cooled(key: string, now = Date.now()): boolean {
    const f = this.fails.get(key);
    return Boolean(f && f.n >= this.tripAfter && f.until > now);
  }
  failure(key: string, now = Date.now()): void {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= this.tripAfter) f.until = now + this.cooldownMs;
    this.fails.set(key, f);
  }
  success(key: string): void {
    this.fails.delete(key);
  }
  /** Healthy targets first (order kept), cooled ones last. */
  order<T>(targets: readonly T[], keyOf: (t: T) => string, now = Date.now()): T[] {
    const ok = targets.filter((t) => !this.cooled(keyOf(t), now));
    const cooled = targets.filter((t) => this.cooled(keyOf(t), now));
    return [...ok, ...cooled];
  }
}

export interface AttemptLog {
  target: string;
  status: number | null;
  error: string | null;
  retry: number;
}

export interface ChainResult<T, Tg> {
  result: AttemptResult<T>;
  target: Tg | null;
  attempts: AttemptLog[];
}

/** Run `attempt` over the targets with retries + fallbacks. */
export async function runChain<T, Tg>(
  targets: readonly Tg[],
  keyOf: (t: Tg) => string,
  attempt: (t: Tg, retry: number) => Promise<AttemptResult<T>>,
  opts: RetryOptions = DEFAULT_RETRY,
  health?: TargetHealth,
): Promise<ChainResult<T, Tg>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ordered = health ? health.order(targets, keyOf) : [...targets];
  const attempts: AttemptLog[] = [];
  let last: AttemptFail = { ok: false, status: null, error: 'no targets' };
  let lastTarget: Tg | null = null;
  for (const t of ordered) {
    lastTarget = t;
    for (let retry = 0; retry <= opts.retries; retry++) {
      let r: AttemptResult<T>;
      try {
        r = await attempt(t, retry);
      } catch (e) {
        r = { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
      }
      if (r.ok) {
        attempts.push({ target: keyOf(t), status: 200, error: null, retry });
        health?.success(keyOf(t));
        return { result: r, target: t, attempts };
      }
      attempts.push({ target: keyOf(t), status: r.status, error: r.error, retry });
      last = r;
      const cls = classifyFailure(r.status);
      if (cls === 'stop') return { result: r, target: t, attempts };
      if (cls === 'next') break;
      if (retry < opts.retries) await sleep(backoffMs(retry, opts, r.retryAfterMs));
    }
    health?.failure(keyOf(t));
  }
  return { result: last, target: lastTarget, attempts };
}
