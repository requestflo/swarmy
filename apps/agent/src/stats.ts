import os from 'node:os';
import type { DockerClient } from '@swarmy/core/docker';
import type { ContainerMetricsSample, MetricsPayload } from '@swarmy/core/protocol';

interface CpuSample {
  idle: number;
  total: number;
}

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let prev = sampleCpu();

/** Returns node CPU usage as 0..(100 * cpuCount). */
function nodeCpuPercent(): number {
  const cur = sampleCpu();
  const idleDelta = cur.idle - prev.idle;
  const totalDelta = cur.total - prev.total;
  prev = cur;
  const usage = totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
  return usage * 100 * os.cpus().length;
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

function containerCpuPercent(s: DockerStats): number {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const online = s.cpu_stats?.online_cpus ?? os.cpus().length;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * online * 100;
}

function sumNet(s: DockerStats, key: 'rx_bytes' | 'tx_bytes'): number {
  return Object.values(s.networks ?? {}).reduce((a, n) => a + (n[key] ?? 0), 0);
}

export async function collectMetrics(docker: DockerClient): Promise<MetricsPayload> {
  const containers: ContainerMetricsSample[] = [];
  try {
    const list = await docker.docker.listContainers({});
    for (const c of list) {
      try {
        const s = (await (docker.docker.getContainer(c.Id).stats as unknown as (
          o: { stream: false },
        ) => Promise<DockerStats>)({ stream: false })) as DockerStats;
        const memUsed = (s.memory_stats?.usage ?? 0) - (s.memory_stats?.stats?.cache ?? 0);
        containers.push({
          containerId: c.Id,
          name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
          cpuPercent: containerCpuPercent(s),
          memUsedBytes: Math.max(0, memUsed),
          memLimitBytes: s.memory_stats?.limit ?? 0,
          netRxBytes: sumNet(s, 'rx_bytes'),
          netTxBytes: sumNet(s, 'tx_bytes'),
        });
      } catch {
        // container vanished mid-sample; skip.
      }
    }
  } catch {
    // docker unavailable; emit node metrics only.
  }

  return {
    sampledAt: Date.now(),
    node: {
      cpuPercent: nodeCpuPercent(),
      memUsedBytes: os.totalmem() - os.freemem(),
      memTotalBytes: os.totalmem(),
      loadAvg1: os.loadavg()[0],
    },
    containers,
  };
}
