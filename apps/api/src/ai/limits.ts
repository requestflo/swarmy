/**
 * The AI gateway's in-memory limiters (controller-local, single process; a
 * restart forgets them, which is fine: they shed floods, not bill).
 *
 *  - Per virtual key: requests per minute. A key's own `rpm` wins; a key
 *    without one gets {@link DEFAULT_KEY_RPM} (`SWARMY_AI_DEFAULT_RPM`, `0`
 *    or `off` for none), so a leaked or runaway key is bounded by default.
 *  - Per client IP: failed key lookups. After {@link AUTH_FAILURES_PER_MINUTE}
 *    401s in a minute an address gets 429 before any lookup, which caps key
 *    guessing without touching callers that present a valid key.
 */

/** In-memory per-id sliding 60s window. */
export class RpmWindow {
  private hits = new Map<string, number[]>();

  /** Record + allow if under `rpm` in the last 60s. */
  allow(id: string, rpm: number, now = Date.now()): boolean {
    const kept = this.recent(id, now);
    if (kept.length >= rpm) {
      this.hits.set(id, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(id, kept);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  /** Hits for `id` in the last 60s, without recording one. */
  count(id: string, now = Date.now()): number {
    return this.recent(id, now).length;
  }

  private recent(id: string, now: number): number[] {
    return (this.hits.get(id) ?? []).filter((t) => now - t < 60_000);
  }

  private sweep(now: number): void {
    for (const [id, ts] of this.hits) if (!ts.some((t) => now - t < 60_000)) this.hits.delete(id);
  }
}

export const DEFAULT_KEY_RPM = 600;

/** The RPM a key without its own limit gets; null = unlimited. */
export function defaultKeyRpm(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.SWARMY_AI_DEFAULT_RPM?.trim().toLowerCase();
  if (!raw) return DEFAULT_KEY_RPM;
  if (raw === '0' || raw === 'off' || raw === 'none') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_KEY_RPM;
}

/** The limit in force for a key: its own, else the default. */
export function effectiveRpm(keyRpm: number | null, env: Record<string, string | undefined> = process.env): number | null {
  return keyRpm ?? defaultKeyRpm(env);
}

export const AUTH_FAILURES_PER_MINUTE = 20;

/** Per-IP count of failed key lookups (401s). */
export class AuthFailureLimiter {
  private readonly window = new RpmWindow();
  constructor(private readonly max = AUTH_FAILURES_PER_MINUTE) {}

  /** True when `ip` used up its failures for the minute: refuse before looking anything up. */
  blocked(ip: string | null, now = Date.now()): boolean {
    return ip !== null && this.window.count(ip, now) >= this.max;
  }

  /** Record a 401 for `ip`. */
  fail(ip: string | null, now = Date.now()): void {
    if (ip !== null) this.window.allow(ip, this.max, now);
  }
}
