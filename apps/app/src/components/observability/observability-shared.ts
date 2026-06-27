import type { StatusTone } from '@swarmy/ui';

/** Metric presets surfaced in the metrics + by-service panels. */
export const METRIC_PRESETS = [
  { value: 'http.server.duration', label: 'Request latency' },
  { value: 'system.cpu.utilization', label: 'CPU utilization' },
  { value: 'system.memory.usage', label: 'Memory usage' },
] as const;

export type CollectorStatus = 'OFFLINE' | 'DEPLOYING' | 'RUNNING' | 'FAILED';

/** Map collector + store state to a Hot Signal status tone. */
export function heroTone(collectorStatus: CollectorStatus, storeReachable: boolean): StatusTone {
  if (collectorStatus === 'RUNNING' && storeReachable) return 'online';
  if (collectorStatus === 'DEPLOYING') return 'progress';
  if (collectorStatus === 'FAILED') return 'offline';
  return 'neutral';
}

/** Human label for the collector + store state. */
export function heroLabel(collectorStatus: CollectorStatus, storeReachable: boolean): string {
  if (collectorStatus === 'RUNNING') {
    return storeReachable ? 'Collector live · store reachable' : 'Collector live · store unreachable';
  }
  if (collectorStatus === 'DEPLOYING') return 'Deploying';
  if (collectorStatus === 'FAILED') return 'Failed';
  return 'Off';
}
