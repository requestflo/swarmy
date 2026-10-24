import { fromDraft, toDraft, type RouteProtection } from '@/components/ingress/protection-model';

/**
 * The protection cards (board 30) over the route's real protection model
 * (`swarmy.ingress.routes` → RouteProtection): what each card says, whether
 * it is on, and the next protection when it is switched. Every change goes
 * through the editor's own draft round trip, so "nothing enforced" is null
 * exactly as the form saves it.
 */
export type RuleId = 'rate' | 'bots' | 'scanners' | 'countries' | 'ips' | 'size';

export const RATE_PRESETS = [60, 100, 300] as const;

const EMPTY: RouteProtection = { ipAllow: [], ipDeny: [], blockBots: false, requiredHeaders: [] };

/** Apply a change and normalise (null when nothing is enforced). */
export function patch(p: RouteProtection | null, change: Partial<RouteProtection>): RouteProtection | null {
  return fromDraft(toDraft({ ...EMPTY, ...p, ...change }));
}

/** Comma/space separated input → tokens (country codes upper-cased by the model). */
export function tokens(text: string): string[] {
  return text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
}

/** Is this card's rule on? */
export function isOn(p: RouteProtection | null, id: RuleId): boolean {
  switch (id) {
    case 'rate': return !!p?.rateLimit;
    case 'bots': return !!p?.blockBots;
    case 'scanners': return !!p?.waf?.blockScannerPaths;
    case 'countries': return !!(p?.countryAllow?.length || p?.countryDeny?.length);
    case 'ips': return !!(p?.ipAllow.length || p?.ipDeny.length);
    case 'size': return !!p?.bodyMaxSize;
  }
}

/** Switching a card off: drop just that rule. */
export function switchedOff(p: RouteProtection | null, id: RuleId): RouteProtection | null {
  switch (id) {
    case 'rate': return patch(p, { rateLimit: undefined });
    case 'bots': return patch(p, { blockBots: false });
    case 'scanners': {
      const w = p?.waf;
      return patch(p, { waf: w && (w.blockMethods.length || w.denyQueryPatterns.length) ? { ...w, blockScannerPaths: false } : undefined });
    }
    case 'countries': return patch(p, { countryAllow: undefined, countryDeny: undefined });
    case 'ips': return patch(p, { ipAllow: [], ipDeny: [] });
    case 'size': return patch(p, { bodyMaxSize: undefined });
  }
}

/** Switching on a card that needs nothing typed (rate starts at 100 a minute per IP). */
export function switchedOn(p: RouteProtection | null, id: 'rate' | 'bots' | 'scanners'): RouteProtection | null {
  if (id === 'rate') return withRate(p, 100);
  if (id === 'bots') return patch(p, { blockBots: true });
  return patch(p, { waf: { blockMethods: [], denyQueryPatterns: [], ...p?.waf, blockScannerPaths: true } });
}

/** A rate preset: N requests a minute, keyed as before (client IP by default). */
export function withRate(p: RouteProtection | null, perMinute: number): RouteProtection | null {
  const key = p?.rateLimit?.key ?? 'ip';
  const header = p?.rateLimit?.header;
  return patch(p, { rateLimit: { requests: perMinute, windowSeconds: 60, key, ...(key === 'header' && header ? { header } : {}) } });
}

function list(xs: string[]): string {
  return xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`;
}

/** What the card says, in a sentence. */
export function ruleSay(p: RouteProtection | null, id: RuleId, service: string): string {
  switch (id) {
    case 'rate': {
      const r = p?.rateLimit;
      if (!r) return 'No limit: a visitor can send as many requests as they like.';
      const who = r.key === 'header' && r.header ? `Each ${r.header} value` : 'Each visitor IP';
      return r.windowSeconds === 60 ? `${who} gets ${r.requests} requests a minute.` : `${who} gets ${r.requests} requests every ${r.windowSeconds} s.`;
    }
    case 'bots':
      return p?.blockBots ? 'Turns away requests whose browser name says bot, crawler, spider or scan.' : 'Bots and crawlers get through like everyone else.';
    case 'scanners':
      return p?.waf?.blockScannerPaths ? 'Refuses paths only scanners ask for, like /wp-login.php and /.env, with 403.' : `Scanner paths like /wp-login.php reach ${service}.`;
    case 'countries': {
      const allow = p?.countryAllow ?? [];
      const deny = p?.countryDeny ?? [];
      if (!allow.length && !deny.length) return 'Every country gets in.';
      if (allow.length && deny.length) return `Only ${list(allow)} get in, and never ${list(deny)}.`;
      return allow.length ? `Only visitors from ${list(allow)} get in.` : `Turns away visitors from ${list(deny)}. Everyone else gets in.`;
    }
    case 'ips': {
      const allow = p?.ipAllow ?? [];
      const deny = p?.ipDeny ?? [];
      if (!allow.length && !deny.length) return 'Every address gets in.';
      const parts = [deny.length ? `Turns away ${list(deny)}.` : '', allow.length ? `Only ${list(allow)} ${allow.length === 1 ? 'gets' : 'get'} in.` : ''];
      return parts.filter(Boolean).join(' ');
    }
    case 'size':
      return p?.bodyMaxSize ? `Uploads over ${p.bodyMaxSize} are refused.` : 'No size limit on uploads.';
  }
}

/** How many of the cards are on (the flow strip's "N protections on"), the password card included. */
export function rulesOn(p: RouteProtection | null): number {
  const password = p?.basicAuth?.users.length ? 1 : 0;
  return (['rate', 'bots', 'scanners', 'countries', 'ips', 'size'] as const).filter((id) => isOn(p, id)).length + password;
}
