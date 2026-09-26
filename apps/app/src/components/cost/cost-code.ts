import type { CostBudgetView, CostOverviewView } from '@swarmy/core';
import { curl, type CodeTab } from '@/components/calm';

/**
 * Prices live on each server as a Docker label; the totals are computed from
 * them. The budget is a dashboard setting (tRPC `cost.setBudget`; no REST
 * route), shown as the JSON the dashboard saves.
 */
export function costCode(o: CostOverviewView, budget?: CostBudgetView): CodeTab[] {
  const labels = o.nodes
    .map((n) => `${n.name.padEnd(18)} swarmy.node.cost=${n.monthlyUsd ?? '(unset)'}`)
    .join('\n');
  const split = o.stacks.map((s) => `${s.stack.padEnd(18)} $${s.monthlyUsd}/mo  ${s.serviceCount} services${s.partial ? '  (floor)' : ''}`).join('\n');
  const tabs: CodeTab[] = [
    { label: 'server labels', code: `# docker node inspect → Spec.Labels\n${labels}` },
    { label: 'split by app', code: `# memory share of each server × its price\n${split || '# nothing running on a priced server yet'}` },
  ];
  if (budget) {
    const { monthlyUsd, warnAtPct, warnChannelIds, weeklySummary, weeklyChannelIds, timeZone } = budget;
    tabs.push({
      label: 'budget.json',
      code: `# dashboard setting — saved from this page (no REST route yet)\n# warnAtPct is the threshold of the "cost-budget" alert rule\n${JSON.stringify(
        { monthlyUsd, warnAtPct, warnChannelIds, weeklySummary, weeklyChannelIds, weeklySend: `Mon 09:00 ${timeZone}` },
        null,
        2,
      )}`,
    });
  }
  tabs.push({ label: 'REST', code: `${curl('GET', '/nodes')}\n\n# each node's labels carry swarmy.node.cost` });
  return tabs;
}
