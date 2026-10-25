/**
 * May Let's Encrypt issue for a routed host? (board 30, the CAA row). The
 * controller looks up CAA for the host and climbs its parents (RFC 8659)
 * through its own resolver; the pure tree evaluation is `@swarmy/ingress`
 * `evaluateCaa`. swarmy's edge asks Let's Encrypt (Caddy's default ACME CA;
 * swarmy configures no other), so that is the CA judged.
 *
 * The verdict is kept 10 minutes per host in process memory: CAA changes at
 * human speed, and Renew now reads the kept verdict to refuse a renew CAA
 * would make fail.
 */
import { promises as dns } from 'node:dns';
import { caaLookupNames, evaluateCaa, type CaaLookup, type CaaRecord, type CaaVerdict } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { requireRoutedHost } from './routed-host';

/** The CA the edge orders from, and its CAA identifier. */
export const EDGE_ACME_CA = { name: "Let's Encrypt", caa: 'letsencrypt.org' } as const;
export const CAA_TTL_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;

export interface CaaView extends CaaVerdict {
  host: string;
  ca: { name: string; caa: string };
  /** The names asked, in order, up to the one that decided. */
  asked: string[];
  checkedAt: string;
}

export type CaaResolve = (name: string) => Promise<Array<Record<string, unknown>>>;

const kept = new Map<string, { at: number; view: CaaView }>();
const key = (orgId: string, host: string) => `${orgId}\u0000${host}`;

/** node:dns answers `{ critical, issue: 'letsencrypt.org' }`: one property per record. */
function toRecords(raw: Array<Record<string, unknown>>): CaaRecord[] {
  return raw.flatMap((r) =>
    Object.entries(r)
      .filter(([k, v]) => k !== 'critical' && typeof v === 'string')
      .map(([tag, value]) => ({ critical: Number(r.critical) || 0, tag, value: value as string })),
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Climb from the host; stop at the first name with records, or the first that failed. */
export async function lookupCaa(host: string, resolve: CaaResolve): Promise<CaaLookup[]> {
  const out: CaaLookup[] = [];
  for (const name of caaLookupNames(host)) {
    try {
      const raw = await withTimeout(resolve(name), LOOKUP_TIMEOUT_MS);
      const records = toRecords(raw);
      out.push({ name, records });
      if (records.length) break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENODATA' || code === 'ENOTFOUND') {
        out.push({ name, records: [] });
        continue;
      }
      out.push({ name, error: code ?? (e instanceof Error ? e.message : String(e)) });
      break;
    }
  }
  return out;
}

const systemResolve: CaaResolve = (n) => dns.resolveCaa(n) as unknown as Promise<Array<Record<string, unknown>>>;

export async function getCaa(ctx: OrgContext, rawHost: string, resolve: CaaResolve = systemResolve): Promise<CaaView> {
  const host = requireRoutedHost(ctx, rawHost);
  const hit = kept.get(key(ctx.activeOrgId, host));
  if (hit && Date.now() - hit.at < CAA_TTL_MS) return hit.view;
  const lookups = await lookupCaa(host, resolve);
  const view: CaaView = { host, ca: { ...EDGE_ACME_CA }, ...evaluateCaa(host, lookups, EDGE_ACME_CA), asked: lookups.map((l) => l.name), checkedAt: new Date().toISOString() };
  kept.set(key(ctx.activeOrgId, host), { at: Date.now(), view });
  return view;
}

/** The kept verdict for Renew now: false when CAA forbids it, true when it allows, null when not known. */
export function knownCaaAllows(orgId: string, host: string): boolean | null {
  const hit = kept.get(key(orgId, host));
  if (!hit || Date.now() - hit.at >= CAA_TTL_MS) return null;
  return hit.view.state === 'forbidden' ? false : hit.view.state === 'unknown' ? null : true;
}

/** Tests only. */
export function forgetCaa(): void {
  kept.clear();
}
