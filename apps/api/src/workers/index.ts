import { startMetricsSampler } from './metrics-sampler';
import { startRetention } from './retention';
import { startImageGc } from './image-gc';
import { startControllerBackupScheduler } from './controller-backup-scheduler';
import { startBackupScheduler } from './backup-scheduler';
import { startDrReconcile } from './dr-reconcile';

export function startWorkers(): () => void {
  const stops = [
    startMetricsSampler(),
    startRetention(),
    startImageGc(),
    startControllerBackupScheduler(),
    startBackupScheduler(),
    startDrReconcile(),
  ];
  return () => stops.forEach((s) => s());
}
