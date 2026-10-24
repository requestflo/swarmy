/**
 * The wildcard-IP base automatic app addresses fall back to — pure.
 *
 * `<service>-<stack>.<a-b-c-d>.<base>` resolves to a.b.c.d by construction when
 * `<base>` is a wildcard-IP DNS service. sslip.io stays the default; an
 * operator can point every install at another one (nip.io, or a self-hosted
 * sslip-style resolver) with `SWARMY_AUTO_ADDRESS_BASE`, and an org can
 * override that in its own settings — plans/self-reliance.md B2(a).
 */

/**
 * The default wildcard-IP DNS service: answers `<anything>.<a-b-c-d>.<base>`
 * with `a.b.c.d`. Overridable per controller (`SWARMY_AUTO_ADDRESS_BASE`) and
 * per org — e.g. nip.io, or your own sslip-style resolver — so no install
 * depends on one third party (plans/self-reliance.md B2a).
 */
export const DEFAULT_AUTO_ADDRESS_BASE = 'sslip.io';

/** Well-known wildcard-IP services, recognised in the installer's dashboard domain. */
const KNOWN_WILDCARD_BASES = ['sslip.io', 'nip.io'];

const DNS_NAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A configured wildcard base, lowercased and trimmed; null when it isn't a DNS name. */
export function normalizeAutoAddressBase(raw: string | null | undefined): string | null {
  const b = raw?.trim().toLowerCase().replace(/^\*?\.+/, '').replace(/\.$/, '') ?? '';
  return DNS_NAME.test(b) ? b : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The wildcard-IP base for this org's edge (`<a-b-c-d>.<base>`), or null when
 * no address can be formed. `base` = the configured wildcard service (org
 * setting, else `SWARMY_AUTO_ADDRESS_BASE`); unset keeps sslip.io — and the
 * installer's own sslip/nip dashboard domain — exactly as before.
 */
export function autoAddressBaseFor(input: {
  dashboardDomain?: string | null;
  edgeIps: readonly string[];
  base?: string | null;
}): string | null {
  const base = normalizeAutoAddressBase(input.base);
  const d = input.dashboardDomain?.trim().toLowerCase().replace(/\.$/, '');
  if (d) {
    // The installer's `swarmy.<a-b-c-d>.<base>` (dashed or dotted): reuse its IP.
    const services = [...new Set([...(base ? [base] : []), ...KNOWN_WILDCARD_BASES])].map(escapeRe).join('|');
    const dashed = d.match(new RegExp(`(?:^|\\.)(\\d{1,3}-\\d{1,3}-\\d{1,3}-\\d{1,3})\\.(${services})$`));
    if (dashed) return `${dashed[1]}.${base ?? dashed[2]}`;
    const dotted = d.match(new RegExp(`(?:^|\\.)(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(${services})$`));
    if (dotted) return `${dotted.slice(1, 5).join('-')}.${base ?? dotted[5]}`;
  }
  const svc = base ?? DEFAULT_AUTO_ADDRESS_BASE;
  const ips = [...input.edgeIps].sort();
  const v4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (v4) return `${v4.replace(/\./g, '-')}.${svc}`;
  const v6 = ips.find((ip) => ip.includes(':'));
  if (v6) return `${v6.toLowerCase().replace(/:/g, '-')}.${svc}`;
  return null;
}
