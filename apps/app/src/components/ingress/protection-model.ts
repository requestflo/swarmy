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

export interface RouteProtection {
  rateLimit?: RateLimitRule;
  ipAllow: string[];
  ipDeny: string[];
  bodyMaxSize?: string;
  blockBots: boolean;
  requiredHeaders: { name: string; value?: string }[];
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
  };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
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
  if (d.rateLimitOn && d.requests > 0 && d.windowSeconds > 0) {
    out.rateLimit = {
      requests: Math.round(d.requests),
      windowSeconds: Math.round(d.windowSeconds),
      key: d.key,
      ...(d.key === 'header' && d.header.trim() ? { header: d.header.trim() } : {}),
    };
  }
  if (d.bodyMaxSize.trim()) out.bodyMaxSize = d.bodyMaxSize.trim();
  const active =
    out.rateLimit !== undefined ||
    out.ipAllow.length > 0 ||
    out.ipDeny.length > 0 ||
    out.bodyMaxSize !== undefined ||
    out.blockBots ||
    out.requiredHeaders.length > 0;
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
  if (p.bodyMaxSize) chips.push(`body ≤ ${p.bodyMaxSize}`);
  if (p.blockBots) chips.push('bots blocked');
  const hdrs = p.requiredHeaders?.length ?? 0;
  if (hdrs > 0) chips.push(`${hdrs} required header${hdrs === 1 ? '' : 's'}`);
  return chips;
}
