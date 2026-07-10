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
// Agent-binary release: the install routes serve these binaries and pin their
// checksums into the rendered installer.
export { agentRelease, agentBinaryPath } from './services/agent-release.service';
export type { AgentReleaseManifest } from './services/agent-release.service';
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
export {
  setNodeAvailability,
  setNodeLabels,
  removeNode,
  stampReportedPublicIp,
  stampProfileLabels,
} from './services/node.service';
// WS7 private-mesh profile: the register path auto-enrolls the node into the mesh.
export { enrollNode as enrollMeshNode } from './services/mesh.service';
// ── geo-dns ("swarmy is the nameserver"): worker + REST seams ──
export {
  listDnsView,
  checkDomain,
  reconcileDnsOrg,
  resolveProviderToken,
  syncProviderZones,
} from './services/geodns.service';
export type { DnsViewRow, DomainCheck, DnsReconcileDeps } from './services/geodns.service';
export {
  listZones as listDnsZones,
  createZone as createDnsZone,
  updateZone as updateDnsZone,
  removeZone as removeDnsZone,
  checkDelegation as checkDnsDelegation,
} from './services/dns-zones.service';
export type { DnsZoneView, DelegationCheck } from './services/dns-zones.service';
export {
  listRecords as listDnsRecords,
  upsertRecord as upsertDnsRecord,
  removeRecord as removeDnsRecord,
} from './services/dns-records.service';
export type { DnsRecordView } from './services/dns-records.service';
export { regionUpstreamsFor, siblingSetSignature } from './services/ingress-regions';
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
  STACK_RETENTION_LABEL,
  parseRetentionDays,
  stackRetentionFor,
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
  mintSetupKeyForOrg,
} from './services/mesh.service';
export type { MintedSetupKey } from './services/mesh.service';
export { submitRecoveryClaim, pollRecoveryClaim } from './services/recovery.service';

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
