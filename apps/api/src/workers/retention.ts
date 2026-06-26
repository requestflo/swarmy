import { prisma } from '@swarmy/db';
import { env } from '../env';

/** Hourly range-delete of metric samples older than the retention window. */
export function startRetention(): () => void {
  const run = async () => {
    const cutoff = new Date(Date.now() - env.METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await prisma.metricSample.deleteMany({ where: { ts: { lt: cutoff } } }).catch(() => undefined);
  };
  const timer = setInterval(run, 60 * 60 * 1000);
  return () => clearInterval(timer);
}
