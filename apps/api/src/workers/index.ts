import { startMetricsSampler } from './metrics-sampler';
import { startRetention } from './retention';
import { startImageGc } from './image-gc';
import { startControllerBackupScheduler } from './controller-backup-scheduler';
import { startBackupScheduler } from './backup-scheduler';
import { startDrReconcile } from './dr-reconcile';
import { startObservabilityReconcile } from './observability-reconcile';
import { startGeoDnsReconcile } from './geodns-reconcile';

export function startWorkers(): () => void {
  const stops = [
    startMetricsSampler(),
    startRetention(),
    startImageGc(),
    startControllerBackupScheduler(),
    startBackupScheduler(),
    startDrReconcile(),
    startObservabilityReconcile(),
    startGeoDnsReconcile(),
  ];
  return () => stops.forEach((s) => s());
}
