import type { CostOverviewView } from '@swarmy/core';
import { curl, type CodeTab } from '@/components/calm';

/** Prices live on each server as a Docker label; the totals are computed from them. */
export function costCode(o: CostOverviewView): CodeTab[] {
  const labels = o.nodes
    .map((n) => `${n.name.padEnd(18)} swarmy.node.cost=${n.monthlyUsd ?? '(unset)'}`)
    .join('\n');
  const split = o.stacks.map((s) => `${s.stack.padEnd(18)} $${s.monthlyUsd}/mo  ${s.serviceCount} services${s.partial ? '  (floor)' : ''}`).join('\n');
  return [
    { label: 'server labels', code: `# docker node inspect → Spec.Labels\n${labels}` },
    { label: 'split by app', code: `# memory share of each server × its price\n${split || '# nothing running on a priced server yet'}` },
    { label: 'REST', code: `${curl('GET', '/nodes')}\n\n# each node's labels carry swarmy.node.cost` },
  ];
}
