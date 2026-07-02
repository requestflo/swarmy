export { appRouter, type AppRouter } from './root';
export { createContext } from './context';
export type { BaseContext, AuthedContext, OrgContext, CreateContextOptions } from './context';
export type {
  AgentHub,
  CommandName,
  CommandResult,
} from './hub/types';
export { COMMAND_PROTOCOL_TYPE } from './hub/types';
export { writeAudit } from './services/audit.service';
export type { AuditEntry, AuditActorType } from './services/audit.service';
export * from './errors';

// ── REST front door: api-key→OrgContext seam + service functions it reuses ──
export { resolveOrgContextFromApiKey } from './apiKeyContext';
export type { ResolvedApiKeyContext, ResolveApiKeyDeps, ApiKeyScope } from './apiKeyContext';
export { getNode, listNodes } from './services/node.service';
export {
  createService,
  getServiceDetail,
  listServices,
  removeService,
  restartService,
  scaleService,
} from './services/service.service';
export { deployFromCompose, getStack, listStacks, removeStack } from './services/stack.service';
export type { StackSummary, StackDetail } from './services/stack.service';
export {
  addDomain,
  listDomains,
  removeDomain,
  reconcileColdIngress,
  reapplyIngressForOrg,
} from './services/ingress.service';
export type { DomainView, IngressConfigView, IngressColdReconcileDeps } from './services/ingress.service';

// ── git-cicd-registry P2: webhook + GC + build-log seams ──
export { buildLogBus } from './services/build-log-bus';
export {
  triggerBuildForRepo,
  autodeployBuilt,
  systemContext,
  computeGcPlan,
  bareDigest,
} from './services/cicd.service';
export type { GcCandidate, GcPlan, GcPlanInput, BuildLogLine } from './services/cicd.service';
export {
  runImageGcForOrg,
  runImageGcAllOrgs,
  computePinnedDigests,
} from './services/image-gc.service';
export type { GcRunResult } from './services/image-gc.service';

// ── data-store P1: controller-state backup/restore seams ──
export { isBackupDue, runControllerBackup } from './services/controllerBackup.service';
export { restoreBundle } from './services/controllerBackup.bundle';
export { loadControlPlane } from './services/controllerBackup.dump';

// ── node-onboarding P2: swarm init/join orchestration (gateway register seam) ──
export { orchestrateSwarmMembership, SWARM_COMMAND } from './services/swarm.service';
export type {
  OrchestrateArgs,
  OrchestrateOutcome,
  SwarmHub,
  SwarmDb,
  SwarmConfigRow,
} from './services/swarm.service';

// ── public-api-terraform P2 (Wave G1): REST CRUD service fns ──
export { listApiKeys, createApiKey, revokeApiKey } from './services/apiKeys.service';
export { setNodeAvailability, setNodeLabels, removeNode } from './services/node.service';
export {
  listRecords as listDnsRecords,
  upsertRecord as upsertDnsRecord,
  removeRecord as removeDnsRecord,
} from './services/geodns.service';
// ── geodns P3: DNS view + provider sync seam (reused by the reconcile worker) ──
export {
  listDnsView,
  checkDomain,
  reconcileGeoDns,
  buildZoneSnapshot,
  resolveProviderToken,
} from './services/geodns.service';
export type { DnsViewRow, DomainCheck } from './services/geodns.service';
export {
  resolveGeoLite,
  geoipEnabled,
  parseGeoDnsSettings,
} from './services/geodns-geolite';
export type { GeoDnsSettings, GeoLitePlan } from './services/geodns-geolite';
export {
  syncProviderZone,
  getDnsProvider,
  isSyncProvider,
  desiredRecords,
  diffRecords,
} from './services/geodns-provider';
export type {
  DnsProvider,
  ProviderName,
  ProviderZoneSnapshot,
  ProviderEndpoint,
  ProviderSyncResult,
  ProviderSyncOptions,
} from './services/geodns-provider';
export {
  listTargets as listBackupTargets,
  addTarget as addBackupTarget,
  removeTarget as removeBackupTarget,
  backupVolume,
  listSnapshots,
  restoreSnapshot,
} from './services/backups.service';
export {
  list as listClusterVolumes,
  register as registerClusterVolume,
  deregister as deregisterClusterVolume,
} from './services/clusterVolume.service';
export {
  listRoutes as listMeshRoutes,
  grantDirectRoute,
  revokeDirectRoute,
} from './services/mesh.service';

// ── public-api-terraform P2: OAuth2 client-credentials seam ──
export {
  createOAuthClient,
  listOAuthClients,
  revokeOAuthClient,
  verifyClientCredentials,
  issueToken,
  OAUTH_TOKEN_TTL_SECONDS,
  OAUTH_CLIENT_PREFIX,
  OAUTH_SECRET_PREFIX,
} from './services/oauth.service';
export type {
  OAuthScope,
  OAuthClientView,
  OAuthClientIssued,
  OAuthTokenIssued,
  IssueTokenDeps,
} from './services/oauth.service';

// ── public-api-terraform P2: outbound webhook delivery seam ──
export {
  signPayload,
  verifySignature,
  backoffMs,
  enqueueEvent,
  registerEndpoint,
  listEndpoints,
  removeEndpoint,
  setEndpointActive,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
  MAX_ATTEMPTS,
  WEBHOOK_SECRET_PREFIX,
} from './services/webhooks-out.service';
export type {
  WebhookEndpointView,
  WebhookEndpointIssued,
  DeliveryStatus,
} from './services/webhooks-out.service';

// ── platform buildout spine: cross-slice contract seams (see plans/platform-buildout-manifest.md) ──
export { evaluateAdmission } from './services/admission.service';
export type { AdmissionIntent, Violation } from './services/admission.service';
export { summarizeStack, summarizeService } from './services/health-summary';
export type { HealthSummary } from './services/health-summary';
export { fireEvent } from './services/alerts-fire';
export type { FireEventInput } from './services/alerts-fire';
export { recordIncidentEvent } from './services/incidents-record';
export { sendNotification } from './services/notifications-send';
