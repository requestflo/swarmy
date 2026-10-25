/**
 * Heroku domains → web's `domains:` (swarmy's routes), for {@link fromHeroku}.
 * Pure. Custom domains carry over; the app's own `*.herokuapp.com` name
 * doesn't, since swarmy gives the app an address of its own. Nothing moves
 * until each domain's DNS points at swarmy: Heroku keeps serving it until then.
 */
import type { HerokuGap } from './from-heroku-addons';

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HEROKU_OWN = /\.(herokuapp\.com|herokudns\.com|herokussl\.com)$/;

export interface DomainConversion {
  domains: string[];
  changes: string[];
  gaps: HerokuGap[];
}

export function convertDomains(hosts: readonly string[]): DomainConversion {
  const c: DomainConversion = { domains: [], changes: [], gaps: [] };
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!host || c.domains.includes(host)) continue;
    const key = `domains: ${raw.trim()}`;
    if (HEROKU_OWN.test(host)) {
      c.gaps.push({ key, reason: 'Heroku’s own address for the app stays with Heroku; swarmy gives the app an address of its own', handled: true });
    } else if (!HOST.test(host)) {
      c.gaps.push({ key, reason: 'that isn’t a hostname swarmy can route: add it on the app’s Domains page if it is one' });
    } else {
      c.domains.push(host);
    }
  }
  if (c.domains.length) {
    const list = c.domains.join(', ');
    c.changes.push(
      `${list} ${c.domains.length === 1 ? 'becomes web’s domain' : 'become web’s domains'} (services.web.domains): swarmy gets the certificate once DNS points at your servers, and Heroku keeps serving ${c.domains.length === 1 ? 'it' : 'them'} until then.`,
    );
  }
  return c;
}

/**
 * The hostnames in `heroku domains` output (both tables), a plain list, or
 * the Platform API's `GET /apps/{app}/domains` JSON. Headers and the DNS
 * target columns are skipped.
 */
export function readHerokuDomains(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const rows = JSON.parse(t) as unknown;
      return Array.isArray(rows) ? rows.flatMap((r) => (r && typeof r === 'object' && typeof (r as { hostname?: unknown }).hostname === 'string' ? [(r as { hostname: string }).hostname] : [])) : [];
    } catch {
      return [];
    }
  }
  return t.split(/\r?\n/).flatMap((line) => {
    const first = line.trim().split(/[\s,]+/)[0]?.toLowerCase().replace(/\.$/, '') ?? '';
    return !line.startsWith('===') && HOST.test(first) ? [first] : [];
  });
}
