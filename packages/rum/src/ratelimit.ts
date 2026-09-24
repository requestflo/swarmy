/**
 * In-memory token buckets for the public ingest (per app + per client). A
 * controller restart forgets them, which is fine: they only shed floods.
 * Bounded: the map is swept when it grows past `maxKeys`.
 */
export interface RateLimitOptions {
  /** Tokens added per second. */
  ratePerSec: number;
  /** Bucket size (burst). */
  burst: number;
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly opts: RateLimitOptions) {}

  /** Take `cost` tokens for `key`; false when the bucket is empty. */
  take(key: string, now = Date.now(), cost = 1): boolean {
    const { ratePerSec, burst } = this.opts;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= (this.opts.maxKeys ?? 50_000)) this.sweep(now);
      b = { tokens: burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
    b.at = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  private sweep(now: number): void {
    const full = this.opts.burst / this.opts.ratePerSec;
    for (const [k, b] of this.buckets) {
      if ((now - b.at) / 1000 >= full) this.buckets.delete(k);
    }
    // Still too many: drop the oldest half (insertion order ≈ age).
    if (this.buckets.size >= (this.opts.maxKeys ?? 50_000)) {
      let n = Math.floor(this.buckets.size / 2);
      for (const k of this.buckets.keys()) {
        if (n-- <= 0) break;
        this.buckets.delete(k);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
