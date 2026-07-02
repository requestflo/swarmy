import { startMetricsSampler } from './metrics-sampler';
import { startRetention } from './retention';
import { startImageGc } from './image-gc';
import { startControllerBackupScheduler } from './controller-backup-scheduler';
import { startBackupScheduler } from './backup-scheduler';
import { startDrReconcile } from './dr-reconcile';
import { startObservabilityReconcile } from './observability-reconcile';
import { startGeoDnsReconcile } from './geodns-reconcile';
import { startWebhookDispatch } from './webhook-dispatch';
import { startScaleToZero } from './scale-to-zero';
import { startRegionReconcile } from './region-reconcile';
import { startIngressReconcile } from './ingress-reconcile';
import { startManagedDbReconcile } from './manageddb-reconcile';
import { startCacheReconcile } from './cache-reconcile';
import { startSearchReconcile } from './search-reconcile';
import { startVectorReconcile } from './vector-reconcile';
import { startQueueReconcile } from './queue-reconcile';
import { startJobScheduler } from './job-scheduler';
import { startWorkflowRunner } from './workflow-runner';
import { startInboundWebhookDispatch } from './inbound-webhook-dispatch';
import { startAlertEvaluator } from './alert-evaluator';
import { startDeploySafety } from './deploy-safety';
import { startPreviewReconcile } from './preview-reconcile';
import { startNotificationDispatch } from './notification-dispatch';
import { startExposureAudit } from './exposure-audit';

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
    startWebhookDispatch(),
    startScaleToZero(),
    startRegionReconcile(),
    startIngressReconcile(),
    startManagedDbReconcile(),
    startCacheReconcile(),
    startSearchReconcile(),
    startVectorReconcile(),
    startQueueReconcile(),
    startJobScheduler(),
    startWorkflowRunner(),
    startInboundWebhookDispatch(),
    startAlertEvaluator(),
    startDeploySafety(),
    startPreviewReconcile(),
    startNotificationDispatch(),
    startExposureAudit(),
  ];
  return () => stops.forEach((s) => s());
}
