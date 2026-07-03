import { DB_LAG_WARN_SECONDS } from '@swarmy/core';
import type { StatusTone } from '@swarmy/ui';

/** The subset of a `db.get` cluster view the tone/label computation reads. */
export interface DbClusterToneInput {
  primary: { status: string };
  replicas: { running: number; desired: number };
  maxLagSeconds?: number;
}

/** Worst-of status tone + a short human label for a managed-DB cluster's live topology. */
export function dbClusterTone(view: DbClusterToneInput | null): { tone: StatusTone; label: string } {
  if (!view) return { tone: 'neutral', label: '—' };

  const replicasOk = view.replicas.running >= view.replicas.desired;
  const lagging = (view.maxLagSeconds ?? 0) > DB_LAG_WARN_SECONDS;

  const tone: StatusTone =
    view.primary.status === 'absent'
      ? 'offline'
      : view.primary.status === 'running' && replicasOk && !lagging
        ? 'online'
        : view.primary.status === 'deploying'
          ? 'progress'
          : 'warning';
  const label =
    view.primary.status === 'absent' ? 'absent' : lagging ? 'lagging' : replicasOk ? 'healthy' : 'degraded';

  return { tone, label };
}
