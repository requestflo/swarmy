import { startMetricsSampler } from './metrics-sampler';
import { startRetention } from './retention';
import { startImageGc } from './image-gc';
import { startNodeHygiene } from './node-hygiene';
import { startControllerBackupScheduler } from './controller-backup-scheduler';
import { startSwarmKvRestore } from './swarm-kv-restore';
import { startBackupScheduler } from './backup-scheduler';
import { startOffsiteMirror } from './offsite-mirror';
import { startDrReconcile } from './dr-reconcile';
import { startObservabilityReconcile } from './observability-reconcile';
import { startDnsReconcile } from './dns-reconcile';
import { startWebhookDispatch } from './webhook-dispatch';
import { startScaleToZero } from './scale-to-zero';
import { startRegionReconcile } from './region-reconcile';
import { startIngressReconcile } from './ingress-reconcile';
import { startDomainVerify } from './domain-verify';
import { startManagedDbReconcile } from './manageddb-reconcile';
import { startCacheReconcile } from './cache-reconcile';
import { startSearchReconcile } from './search-reconcile';
import { startVectorReconcile } from './vector-reconcile';
import { startStorageReconcile } from './storage-reconcile';
import { startQueueReconcile } from './queue-reconcile';
import { startJobScheduler } from './job-scheduler';
import { startWorkflowRunner } from './workflow-runner';
import { startInboundWebhookDispatch } from './inbound-webhook-dispatch';
import { startAlertEvaluator } from './alert-evaluator';
import { startDeploySafety } from './deploy-safety';
import { startPreviewReconcile } from './preview-reconcile';
import { startAppReconcile } from './app-reconcile';
import { startNotificationDispatch } from './notification-dispatch';
import { startExposureAudit } from './exposure-audit';
import { startMeshMigrationResumer } from './mesh-migration';
import { startSystemImageMirror } from './system-image-mirror';
import { startTrivyDbRefresh } from './trivy-db-refresh';
import { startPlatformUpgradeWorker } from './platform-upgrade';
import { startAppSecretGc } from './app-secret-gc';
import { startRumRetention } from './rum-retention';
import { startErrorsAlerts } from './errors-alerts';
import { startEmailReconcile } from './email-reconcile';

export function startWorkers(): () => void {
  const stops = [
    // First: a restored bundle's swarm config goes back before reconcilers read it.
    startSwarmKvRestore(),
    startMetricsSampler(),
    startRetention(),
    startImageGc(),
    startNodeHygiene(),
    startControllerBackupScheduler(),
    startBackupScheduler(),
    startOffsiteMirror(),
    startDrReconcile(),
    startObservabilityReconcile(),
    startDnsReconcile(),
    startWebhookDispatch(),
    startScaleToZero(),
    startRegionReconcile(),
    startIngressReconcile(),
    startDomainVerify(),
    startManagedDbReconcile(),
    startCacheReconcile(),
    startSearchReconcile(),
    startVectorReconcile(),
    startStorageReconcile(),
    startQueueReconcile(),
    startJobScheduler(),
    startWorkflowRunner(),
    startInboundWebhookDispatch(),
    startAlertEvaluator(),
    startDeploySafety(),
    startPreviewReconcile(),
    startAppReconcile(),
    startNotificationDispatch(),
    startExposureAudit(),
    startMeshMigrationResumer(),
    startSystemImageMirror(),
    startTrivyDbRefresh(),
    startPlatformUpgradeWorker(),
    startAppSecretGc(),
    startRumRetention(),
    startErrorsAlerts(),
    startEmailReconcile(),
  ];
  return () => stops.forEach((s) => s());
}
