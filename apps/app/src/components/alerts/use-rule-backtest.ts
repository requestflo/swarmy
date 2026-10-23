import { useQuery } from '@tanstack/react-query';
import { ALERT_SIGNAL_INFO, type AlertSelector, type AlertSignal } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import type { BacktestGrid, BacktestSubject } from './rule-backtest';
import { useErrorRateHistory } from './use-error-rate-history';

/**
 * Where a rule's "would have fired" comes from. `none` = the signal has no
 * history to replay; `empty` = it could, but there's nothing to replay (with
 * the plain reason); `ready` = a week of real readings on one grid.
 */
export type BacktestSource =
  | { state: 'none'; why: string }
  | { state: 'pending' }
  | { state: 'empty'; why: string }
  | { state: 'ready'; grid: BacktestGrid; subjects: BacktestSubject[]; tech: string };

/** The signals swarmy keeps a week of readings for. */
export const BACKTEST_SIGNALS: ReadonlySet<string> = new Set(['error-rate', 'disk-usage']);
const STALE = 5 * 60_000;

export function useRuleBacktest(signal: string, selector: AlertSelector): BacktestSource {
  const trpc = useTRPC();
  const errors = useErrorRateHistory(signal === 'error-rate', selector);
  const isDisk = signal === 'disk-usage';
  const disk = useQuery({
    ...trpc.alerts.diskHistory.queryOptions(selector.server ? { server: selector.server } : {}),
    enabled: isDisk,
    staleTime: STALE,
    refetchInterval: STALE,
  });

  if (signal === 'error-rate') return errors;
  if (!isDisk) {
    const label = ALERT_SIGNAL_INFO[signal as AlertSignal]?.label.toLowerCase() ?? signal;
    return { state: 'none', why: `A backtest isn’t available for ${label} alerts: swarmy keeps no week of readings to replay a new setting against.` };
  }
  if (disk.isPending) return { state: 'pending' };
  const where = selector.server ?? 'any server';
  if (disk.isError) return { state: 'empty', why: `Couldn’t read the disk history for ${where}: ${disk.error.message}` };
  const servers = disk.data.servers;
  if (servers.length === 0) return { state: 'empty', why: `swarmy has no disk readings for ${where} from the last 7 days yet.` };
  return {
    state: 'ready',
    grid: { from: Date.parse(disk.data.from), stepMs: disk.data.stepSeconds * 1000, slots: Math.max(...servers.map((s) => s.peaks.length)) },
    subjects: servers.map((s) => ({ name: s.name, values: s.peaks })),
    tech: `alerts.diskHistory · ${servers.length === 1 ? servers[0]!.name : `${servers.length} servers`} · 5-minute peaks of the per-minute samples · the live check reads the newest one`,
  };
}
