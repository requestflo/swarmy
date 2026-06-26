import { prisma } from '@swarmy/db';
import { env } from '../env';
import { store } from '../gateway';

/**
 * Periodically flush a downsampled metric row per node into Postgres (history),
 * and snapshot the latest sample onto Node.latestMetrics for instant reads.
 * High-frequency live stats stay in the in-memory ring (no write amplification).
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
        await prisma.node.update({
          where: { id: nodeId },
          data: {
            latestMetrics: {
              cpuPercent: snap.cpuPercent,
              memUsedBytes: snap.memUsedBytes,
              memTotalBytes: snap.memTotalBytes,
              ts: snap.ts,
            },
          },
        });
      } catch {
        // node may have been removed; ignore.
      }
    }
  }, env.METRICS_SAMPLE_INTERVAL_MS);

  return () => clearInterval(timer);
}
