import type { Tone } from '@/components/calm';
import { domainWords } from '@/components/app-domains/domain-words';
import type { StackDomain } from '@/components/ingress/stack-domain-row';

/**
 * Each environment lane's addresses (board Environments: `l.domain`): the
 * routes on its stack's services — the same `swarmy.ingress.routes` labels
 * every domain lives on, read through `ingress.listDomains`. A cloned
 * environment's own address (`web-shop-qa.<base>`) is one of them. PURE —
 * unit-tested.
 */

export type LaneDomainSource = StackDomain & { stack: string };

export interface LaneDomain {
  host: string;
  /** `/api` for a path route, '' for the whole host. */
  path: string;
  /** The service it routes to, without the stack prefix (`web`). */
  service: string;
  port: number;
  auto: boolean;
  word: string;
  tone: Tone;
}

const short = (stack: string, name: string): string => (name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name);

/** The lane's addresses, its own domains first, then automatic ones; by host and path. */
export function laneDomains(stack: string, domains: readonly LaneDomainSource[]): LaneDomain[] {
  return domains
    .filter((d) => d.stack === stack)
    .map((d) => {
      const { word, tone } = domainWords(d);
      return {
        host: d.host,
        path: d.pathPrefix && d.pathPrefix !== '/' ? d.pathPrefix : '',
        service: short(stack, d.serviceName),
        port: d.targetPort,
        auto: Boolean(d.auto),
        word,
        tone,
      };
    })
    .sort((a, b) => Number(a.auto) - Number(b.auto) || a.host.localeCompare(b.host) || a.path.localeCompare(b.path));
}

/** The hosts a removal takes down (each once). */
export const laneHosts = (domains: readonly LaneDomain[]): string[] => [...new Set(domains.map((d) => d.host))];

/** "2 addresses" / "No address yet". */
export function addressCount(n: number): string {
  return n === 0 ? 'No address yet' : n === 1 ? '1 address' : `${n} addresses`;
}
