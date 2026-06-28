import { prisma } from '@swarmy/db';
import { env } from '../env';
import { store } from '../gateway';

/**
 * Periodically flush a downsampled metric row per node into Postgres (history).
 * The latest live sample is served straight from the in-memory hub ring (Docker
 * truth) — no Node.latestMetrics column, no write amplification. `nodeId` is
 * persisted as a plain string id; node swarm/telemetry state is never written.
 */
export function startMetricsSampler(): () => void {
  const timer = setInterval(async () => {
    const samples = [...store.nodeStats.entries()];
    if (!samples.length) return;
    const ts = new Date();

    for (const [nodeId, snap] of samples) {
      const orgId = store.nodeOrg.get(nodeId);
      if (!orgId) continue;
      try {
        await prisma.metricSample.create({
          data: {
            orgId,
            nodeId,
            scope: 'NODE',
            cpuPercent: snap.cpuPercent,
            memUsedBytes: BigInt(Math.round(snap.memUsedBytes)),
            memTotalBytes: BigInt(Math.round(snap.memTotalBytes)),
            netRxBytes: BigInt(Math.round(snap.netRxBytes)),
            netTxBytes: BigInt(Math.round(snap.netTxBytes)),
            diskUsedBytes: BigInt(Math.round(snap.fsUsedBytes ?? 0)),
            diskTotalBytes: BigInt(Math.round(snap.fsTotalBytes ?? 0)),
            ts,
          },
        });
      } catch {
        // node may have been removed; ignore.
      }
    }
  }, env.METRICS_SAMPLE_INTERVAL_MS);

  return () => clearInterval(timer);
}
