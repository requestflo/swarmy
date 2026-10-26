import type { CostNodeView } from '@swarmy/core';
import { MIB } from '@/components/service-settings/settings-model';
import { sizeWords, type Limits } from './size-model';

/**
 * What a size costs a month (board AppScaling: "1 CPU · 512 MB ≈ $4/mo on
 * these servers"), from the servers' monthly prices (`swarmy.node.cost`,
 * `cost.overview`). The same memory-share rule the Cost page estimates
 * with: a copy costs its memory's share of its server's price. Averaged
 * over the priced servers it runs on; when none of those is priced, over
 * every priced server. No priced server → no price, never a guess.
 * PURE — unit-tested in size-cost.test.ts.
 */

export interface SizeCostBasis {
  /** Mean monthly USD per GB of memory across the servers priced. */
  usdPerGb: number;
  servers: number;
  /** `these`: the servers its copies run on · `priced`: every priced server (none of its own is). */
  scope: 'these' | 'priced';
}

const rateOf = (n: Pick<CostNodeView, 'monthlyUsd' | 'memGb'>): number | null =>
  n.monthlyUsd != null && n.memGb != null && n.memGb > 0 ? n.monthlyUsd / n.memGb : null;

export function sizeCostBasis(nodes: ReadonlyArray<Pick<CostNodeView, 'nodeId' | 'monthlyUsd' | 'memGb'>>, hostIds: readonly string[]): SizeCostBasis | null {
  const hosts = new Set(hostIds);
  const pick = (scope: SizeCostBasis['scope']): SizeCostBasis | null => {
    const rates = nodes.filter((n) => scope === 'priced' || hosts.has(n.nodeId)).flatMap((n) => rateOf(n) ?? []);
    if (rates.length === 0) return null;
    return { usdPerGb: rates.reduce((a, b) => a + b, 0) / rates.length, servers: rates.length, scope };
  };
  return pick('these') ?? pick('priced');
}

/** Monthly USD for one copy with this memory ceiling. */
export function copyMonthlyUsd(basis: SizeCostBasis, memoryBytes: number): number {
  return (memoryBytes / (1024 * MIB)) * basis.usdPerGb;
}

/** "$4", "$4.5", "$0.62". */
export function usdWords(n: number): string {
  if (n >= 10) return `$${Math.round(n)}`;
  if (n >= 1) return `$${Math.round(n * 10) / 10}`;
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

const where = (b: SizeCostBasis): string => (b.scope === 'these' ? 'on these servers' : 'on your priced servers');

/** The cost line for these limits: per copy, and for every copy when there are several. */
export function sizeCostLine(basis: SizeCostBasis | null, limits: Limits | undefined, copies: number): string | null {
  if (!basis || limits?.memoryBytes === undefined) return null;
  const one = copyMonthlyUsd(basis, limits.memoryBytes);
  const all = copies > 1 ? `, ${usdWords(one * copies)}/mo for all ${copies}` : '';
  return `${sizeWords(limits)} ≈ ${usdWords(one)}/mo a copy ${where(basis)}${all}.`;
}

/** The Controls line: the rule and the rate. */
export function sizeCostTech(basis: SizeCostBasis): string {
  const n = `${basis.servers} priced server${basis.servers === 1 ? '' : 's'}`;
  return `cost.overview · memory share of swarmy.node.cost · ${usdWords(basis.usdPerGb)}/GB a month across ${n}${basis.scope === 'priced' ? ' (none of its own is priced)' : ''}`;
}
