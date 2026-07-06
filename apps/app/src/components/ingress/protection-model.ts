/**
 * Client-side mirror of the route-protection shape carried on the
 * `swarmy.ingress.routes` service label (see packages/ingress RouteProtectionSchema)
 * plus the pure draft<->protection mapping the inline editor uses. The app does
 * not depend on @swarmy/ingress, so the wire shape is mirrored here.
 */

export interface RateLimitRule {
  requests: number;
  windowSeconds: number;
  key: 'ip' | 'header';
  header?: string;
}

export interface CacheRule {
  ttlSeconds: number;
  keyHeaders?: string[];
  staleWhileRevalidateSeconds?: number;
}

export interface WafRule {
  blockScannerPaths: boolean;
  blockMethods: string[];
  denyQueryPatterns: string[];
}

export interface RouteProtection {
  rateLimit?: RateLimitRule;
  ipAllow: string[];
  ipDeny: string[];
  bodyMaxSize?: string;
  blockBots: boolean;
  requiredHeaders: { name: string; value?: string }[];
  cache?: CacheRule;
  countryAllow?: string[];
  countryDeny?: string[];
  waf?: WafRule;
}

/** Editable string/boolean form state for the inline protection editor. */
export interface ProtectionDraft {
  rateLimitOn: boolean;
  requests: number;
  windowSeconds: number;
  key: 'ip' | 'header';
  header: string;
  ipAllow: string;
  ipDeny: string;
  bodyMaxSize: string;
  blockBots: boolean;
  requiredHeaders: string;
  cacheOn: boolean;
  cacheTtlSeconds: number;
  /** Empty = no stale-while-revalidate window. */
  cacheStaleSeconds: string;
  /** Comma/space-separated header names folded into the cache key. */
  cacheKeyHeaders: string;
  /** Comma/space-separated ISO country codes (uppercased on save). */
  countryAllow: string;
  countryDeny: string;
  wafOn: boolean;
  wafScannerPaths: boolean;
  /** Comma/space-separated HTTP methods to reject (uppercased on save). */
  wafMethods: string;
  /** One regex per line, 403'd when it matches the query string. */
  wafQueryPatterns: string;
}

/** Seed the editor draft from a route's persisted protection (or none). */
export function toDraft(p: RouteProtection | null | undefined): ProtectionDraft {
  return {
    rateLimitOn: Boolean(p?.rateLimit),
    requests: p?.rateLimit?.requests ?? 100,
    windowSeconds: p?.rateLimit?.windowSeconds ?? 60,
    key: p?.rateLimit?.key ?? 'ip',
    header: p?.rateLimit?.header ?? '',
    ipAllow: (p?.ipAllow ?? []).join('\n'),
    ipDeny: (p?.ipDeny ?? []).join('\n'),
    bodyMaxSize: p?.bodyMaxSize ?? '',
    blockBots: p?.blockBots ?? false,
    requiredHeaders: (p?.requiredHeaders ?? [])
      .map((h) => (h.value ? `${h.name}: ${h.value}` : h.name))
      .join('\n'),
    cacheOn: Boolean(p?.cache),
    cacheTtlSeconds: p?.cache?.ttlSeconds ?? 60,
    cacheStaleSeconds:
      p?.cache?.staleWhileRevalidateSeconds !== undefined
        ? String(p.cache.staleWhileRevalidateSeconds)
        : '',
    cacheKeyHeaders: (p?.cache?.keyHeaders ?? []).join(', '),
    countryAllow: (p?.countryAllow ?? []).join(', '),
    countryDeny: (p?.countryDeny ?? []).join(', '),
    wafOn: Boolean(p?.waf),
    wafScannerPaths: p?.waf?.blockScannerPaths ?? true,
    wafMethods: (p?.waf?.blockMethods ?? []).join(', '),
    wafQueryPatterns: (p?.waf?.denyQueryPatterns ?? []).join('\n'),
  };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Comma/whitespace-separated tokens, uppercased (country codes, HTTP methods). */
function upperTokens(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

/** Fold the draft back into the wire shape; null when nothing is enforced. */
export function fromDraft(d: ProtectionDraft): RouteProtection | null {
  const out: RouteProtection = {
    ipAllow: lines(d.ipAllow),
    ipDeny: lines(d.ipDeny),
    blockBots: d.blockBots,
    requiredHeaders: lines(d.requiredHeaders).map((l) => {
      const sep = l.indexOf(':');
      if (sep < 0) return { name: l };
      const value = l.slice(sep + 1).trim();
      return value ? { name: l.slice(0, sep).trim(), value } : { name: l.slice(0, sep).trim() };
    }),
  };
  const countryAllow = upperTokens(d.countryAllow);
  const countryDeny = upperTokens(d.countryDeny);
  if (countryAllow.length > 0) out.countryAllow = countryAllow;
  if (countryDeny.length > 0) out.countryDeny = countryDeny;
  if (d.rateLimitOn && d.requests > 0 && d.windowSeconds > 0) {
    out.rateLimit = {
      requests: Math.round(d.requests),
      windowSeconds: Math.round(d.windowSeconds),
      key: d.key,
      ...(d.key === 'header' && d.header.trim() ? { header: d.header.trim() } : {}),
    };
  }
  if (d.bodyMaxSize.trim()) out.bodyMaxSize = d.bodyMaxSize.trim();
  if (d.cacheOn && d.cacheTtlSeconds > 0) {
    const stale = Number(d.cacheStaleSeconds.trim());
    const keyHeaders = d.cacheKeyHeaders
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean);
    out.cache = {
      ttlSeconds: Math.round(d.cacheTtlSeconds),
      ...(d.cacheStaleSeconds.trim() && Number.isFinite(stale) && stale > 0
        ? { staleWhileRevalidateSeconds: Math.round(stale) }
        : {}),
      ...(keyHeaders.length > 0 ? { keyHeaders } : {}),
    };
  }
  if (d.wafOn) {
    out.waf = {
      blockScannerPaths: d.wafScannerPaths,
      blockMethods: upperTokens(d.wafMethods),
      denyQueryPatterns: lines(d.wafQueryPatterns),
    };
  }
  const active =
    out.rateLimit !== undefined ||
    out.ipAllow.length > 0 ||
    out.ipDeny.length > 0 ||
    out.bodyMaxSize !== undefined ||
    out.blockBots ||
    out.requiredHeaders.length > 0 ||
    out.cache !== undefined ||
    out.countryAllow !== undefined ||
    out.countryDeny !== undefined ||
    out.waf !== undefined;
  return active ? out : null;
}

/** Short chips summarising active protections ("100 req/min", "3 IP rules"). */
export function summarizeProtection(p: RouteProtection | null | undefined): string[] {
  if (!p) return [];
  const chips: string[] = [];
  if (p.rateLimit) {
    const { requests, windowSeconds } = p.rateLimit;
    chips.push(windowSeconds === 60 ? `${requests} req/min` : `${requests} req/${windowSeconds}s`);
  }
  const ipRules = (p.ipAllow?.length ?? 0) + (p.ipDeny?.length ?? 0);
  if (ipRules > 0) chips.push(`${ipRules} IP rule${ipRules === 1 ? '' : 's'}`);
  const countryRules = (p.countryAllow?.length ?? 0) + (p.countryDeny?.length ?? 0);
  if (countryRules > 0) chips.push(`${countryRules} country rule${countryRules === 1 ? '' : 's'}`);
  if (p.cache) chips.push(`cache ${p.cache.ttlSeconds}s`);
  if (p.waf) chips.push('WAF-lite');
  if (p.bodyMaxSize) chips.push(`body ≤ ${p.bodyMaxSize}`);
  if (p.blockBots) chips.push('bots blocked');
  const hdrs = p.requiredHeaders?.length ?? 0;
  if (hdrs > 0) chips.push(`${hdrs} required header${hdrs === 1 ? '' : 's'}`);
  return chips;
}
