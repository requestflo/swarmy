import { startMetricsSampler } from './metrics-sampler';
import { startRetention } from './retention';
import { startImageGc } from './image-gc';
import { startNodeHygiene } from './node-hygiene';
import { startControllerBackupScheduler } from './controller-backup-scheduler';
import { startSwarmKvRestore } from './swarm-kv-restore';
import { startBackupScheduler } from './backup-scheduler';
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
import { startInboundWebhookDispatch } from './inbound-webhook-dispatch';
import { startAlertEvaluator } from './alert-evaluator';
import { startCostWeeklySummary } from './cost-weekly-summary';
import { startDeploySafety } from './deploy-safety';
import { startAppReconcile } from './app-reconcile';
import { startExposureAudit } from './exposure-audit';
import { startMeshPeopleReconcile } from './mesh-people-reconcile';
import { startSwarmJoinRetry } from './swarm-join-retry';
import { startSystemImageMirror } from './system-image-mirror';
import { startTrivyDbRefresh } from './trivy-db-refresh';
import { startPlatformUpgradeWorker } from './platform-upgrade';
import { startAppSecretGc } from './app-secret-gc';
import { startRumRetention } from './rum-retention';
import { startErrorsAlerts } from './errors-alerts';
import { startEmailReconcile } from './email-reconcile';
import { startIntegrationsReconcile } from './integrations-reconcile';
import { startOrphanReconcile } from './orphan-reconcile';
import { startDiskReconcile } from './disk-reconcile';

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
    startInboundWebhookDispatch(),
    startAlertEvaluator(),
    startCostWeeklySummary(),
    startDeploySafety(),
    startAppReconcile(),
    startExposureAudit(),
    startMeshPeopleReconcile(),
    startSwarmJoinRetry(),
    startSystemImageMirror(),
    startTrivyDbRefresh(),
    startPlatformUpgradeWorker(),
    startAppSecretGc(),
    startRumRetention(),
    startErrorsAlerts(),
    startEmailReconcile(),
    startIntegrationsReconcile(),
    startOrphanReconcile(),
    startDiskReconcile(),
  ];
  return () => stops.forEach((s) => s());
}
