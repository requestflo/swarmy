import { prisma, telemetry } from '@swarmy/db';
import { prunePgQuerySamples, pruneAuditLogs } from '@swarmy/trpc';
import { env } from '../env';

/**
 * Hourly retention: range-delete metric samples and slow-query snapshots
 * (telemetry.db) older than the metrics window, and audit rows older than each
 * org's audit-retention setting (default 365d).
 */
export function startRetention(): () => void {
  const run = async () => {
    const cutoff = new Date(Date.now() - env.METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await telemetry.metricSample.deleteMany({ where: { ts: { lt: cutoff } } }).catch(() => undefined);
    await prunePgQuerySamples(telemetry, cutoff).catch(() => undefined);
    await pruneAuditLogs(new Date(), prisma).catch(() => undefined);
  };
  const timer = setInterval(run, 60 * 60 * 1000);
  return () => clearInterval(timer);
}
