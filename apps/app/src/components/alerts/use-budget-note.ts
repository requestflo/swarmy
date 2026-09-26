import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const WORD = { ok: 'on track', warn: 'past the warning', over: 'over budget' } as const;

/** The Budget rule card's line (board 45): "$214 of $300 · on track"; "no budget set" without one. */
export function useBudgetNote(): string | undefined {
  const trpc = useTRPC();
  const budget = useQuery({ ...trpc.cost.budget.queryOptions(), refetchInterval: 60_000 });
  const b = budget.data;
  if (!b) return undefined;
  if (!b.status) return 'no budget set · never fires';
  return `${usd(b.status.projectedUsd)} of ${usd(b.status.budgetUsd)} · ${WORD[b.status.state]}`;
}
