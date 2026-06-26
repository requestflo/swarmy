import { startMetricsSampler } from './metrics-sampler';
import { startRetention } from './retention';

export function startWorkers(): () => void {
  const stops = [startMetricsSampler(), startRetention()];
  return () => stops.forEach((s) => s());
}
