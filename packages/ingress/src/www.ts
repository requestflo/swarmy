/**
 * Apex + www pairing — pure.
 *
 * A route may carry ONE toggle, `www`, that pairs its host with the host's
 * `www.` companion (or, for a `www.` host, with its bare apex):
 *
 *   - `redirect-www-to-apex` — serve the apex, 308 the www host onto it
 *   - `redirect-apex-to-www` — serve the www host, 308 the apex onto it
 *   - `serve-both`           — serve the same routes on both hosts
 *
 * The controller expands routes with {@link expandWww} BEFORE rendering, so
 * every driver just sees plain routes; redirects become
 * {@link HostRedirect}s the renderers emit as their own tiny site blocks.
 * An explicit route for the companion host always wins over the toggle (the
 * user asked for that host by name) — the expansion then skips the clone or
 * redirect rather than rendering two sites for one address.
 */
import { z } from 'zod';

export const WwwModeSchema = z.enum(['redirect-www-to-apex', 'redirect-apex-to-www', 'serve-both']);
export type WwwMode = z.infer<typeof WwwModeSchema>;
export const WWW_MODES: readonly WwwMode[] = WwwModeSchema.options;

/** A host that only redirects (308, path + query preserved) to `to`. */
export const HostRedirectSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** The destination's TLS posture — the redirect site uses the same one. */
  tls: z.enum(['auto', 'off', 'custom']).default('auto'),
});
export type HostRedirect = z.infer<typeof HostRedirectSchema>;

/** Lowercase, strip a trailing dot and any `:port`. */
export function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
}

export function isWildcardHost(host: string): boolean {
  return host.startsWith('*.');
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

/**
 * The apex/www pair for `host`: `acme.com` ↔ `www.acme.com`. Null when the host
 * cannot have a companion (wildcards, IP literals, single-label names).
 */
export function wwwPair(host: string): { apex: string; www: string } | null {
  const h = normalizeHostname(host);
  if (isWildcardHost(h) || isIpLiteral(h)) return null;
  if (h.startsWith('www.')) {
    const apex = h.slice(4);
    return apex.includes('.') ? { apex, www: h } : null;
  }
  return h.includes('.') ? { apex: h, www: `www.${h}` } : null;
}

/** The other half of the pair (`acme.com` → `www.acme.com` and back), or null. */
export function companionHost(host: string): string | null {
  const pair = wwwPair(host);
  if (!pair) return null;
  return normalizeHostname(host) === pair.www ? pair.apex : pair.www;
}

/**
 * Hosts a set of (host, www-mode) route entries makes swarmy answer for — the
 * route hosts plus every companion a toggle adds. The on-demand TLS `ask` gate
 * and DNS verification use this, so a companion is never "unknown".
 */
export function hostsWithCompanions(entries: ReadonlyArray<{ host: string; www?: WwwMode | null }>): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const h = normalizeHostname(e.host);
    out.add(h);
    if (e.www) {
      const c = companionHost(h);
      if (c) out.add(c);
    }
  }
  return [...out];
}

/** Minimal route shape the expansion needs: a host and a TLS mode. */
export interface WwwExpandable {
  domain: string;
  tls: 'auto' | 'off' | 'custom';
}

/**
 * Expand www toggles into plain routes + redirects. `modes` maps a route host
 * (as written on the label) to its toggle; hosts without an entry pass through
 * untouched, so a config with no toggles is returned byte-identical.
 *
 * Deterministic: output routes keep input order (clones follow their source
 * host's routes), redirects are sorted by `from`.
 */
export function expandWww<T extends WwwExpandable>(
  routes: readonly T[],
  modes: ReadonlyMap<string, WwwMode>,
): { routes: T[]; redirects: HostRedirect[] } {
  if (modes.size === 0) return { routes: [...routes], redirects: [] };
  const explicit = new Set(routes.map((r) => r.domain));
  const out: T[] = [];
  const redirects = new Map<string, HostRedirect>();
  const hostTls = (host: string): T['tls'] => {
    const rs = routes.filter((r) => r.domain === host);
    if (rs.some((r) => r.tls === 'custom')) return 'custom';
    if (rs.length > 0 && rs.every((r) => r.tls === 'off')) return 'off';
    return 'auto';
  };

  // Group so all routes of one host move together (multi-path hosts).
  const order: string[] = [];
  const byHost = new Map<string, T[]>();
  for (const r of routes) {
    const list = byHost.get(r.domain);
    if (list) list.push(r);
    else {
      byHost.set(r.domain, [r]);
      order.push(r.domain);
    }
  }

  for (const host of order) {
    const rs = byHost.get(host)!;
    const mode = modes.get(host);
    const pair = mode ? wwwPair(host) : null;
    if (!mode || !pair) {
      out.push(...rs);
      continue;
    }
    const companion = host === pair.www ? pair.apex : pair.www;
    if (mode === 'serve-both') {
      out.push(...rs);
      if (!explicit.has(companion)) out.push(...rs.map((r) => ({ ...r, domain: companion })));
      continue;
    }
    const canonical = mode === 'redirect-apex-to-www' ? pair.www : pair.apex;
    const other = canonical === pair.www ? pair.apex : pair.www;
    // The canonical host is claimed by another explicit route: keep this
    // host's routes where they are and don't redirect (explicit wins).
    if (canonical !== host && explicit.has(canonical)) {
      out.push(...rs);
      continue;
    }
    out.push(...(canonical === host ? rs : rs.map((r) => ({ ...r, domain: canonical }))));
    if (!explicit.has(other) || other === host) {
      redirects.set(other, { from: other, to: canonical, tls: hostTls(host) });
    }
  }
  return {
    routes: out,
    redirects: [...redirects.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
  };
}
