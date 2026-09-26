import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CostBudgetView, NotificationChannelView, SetCostBudgetInput } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export interface CostBudgetApi {
  budget: CostBudgetView | undefined;
  channels: NotificationChannelView[];
  isLoading: boolean;
  /** Save with a patch over the current settings. */
  save: (patch: Partial<SetCostBudgetInput>, done?: string) => void;
  saving: boolean;
  sendTest: () => void;
  sending: boolean;
}

/** The workspace budget (owner decision Q6): the query, the alert channels and the two mutations. */
export function useCostBudget(): CostBudgetApi {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const budget = useQuery({ ...trpc.cost.budget.queryOptions(), refetchInterval: 30_000 });
  const channels = useQuery(trpc.alerts.channels.queryOptions());
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: trpc.cost.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() });
  };
  const set = useMutation(trpc.cost.setBudget.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const test = useMutation(
    trpc.cost.sendWeeklySummaryNow.mutationOptions({
      onSuccess: (r) =>
        r.sent > 0
          ? toast.success(`Sent to ${r.sent} channel${r.sent === 1 ? '' : 's'}: “${r.text}”`)
          : toast.error(r.failed > 0 ? 'The summary didn’t go out. Check the channel with Send test on Alerts.' : 'No channel to send to yet.'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const b = budget.data;
  return {
    budget: b,
    channels: (channels.data ?? []).filter((c) => c.enabled),
    isLoading: budget.isLoading,
    save: (patch, done) => {
      if (!b) return;
      set.mutate(
        {
          monthlyUsd: b.monthlyUsd,
          warnAtPct: b.warnAtPct,
          weeklySummary: b.weeklySummary,
          weeklyChannelIds: b.weeklyChannelIds,
          ...patch,
        },
        done ? { onSuccess: () => toast.success(done) } : undefined,
      );
    },
    saving: set.isPending,
    sendTest: () => test.mutate(),
    sending: test.isPending,
  };
}

/** "#ops Slack" · "every channel" · "#ops Slack + 1 more" — the channel words in a sentence. */
export function channelWords(ids: string[], channels: NotificationChannelView[]): string {
  if (ids.length === 0) return channels.length ? 'every channel' : 'nobody yet';
  const names = channels.filter((c) => ids.includes(c.id)).map((c) => c.name);
  if (names.length === 0) return 'a removed channel';
  return names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} more`;
}

/** "$300" */
export const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
