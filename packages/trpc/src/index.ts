export { appRouter, type AppRouter } from './root';
export { createContext } from './context';
export type { BaseContext, AuthedContext, OrgContext, CreateContextOptions } from './context';
export type {
  AgentHub,
  CommandName,
  CommandResult,
  DispatchDecorator,
} from './hub/types';
export { COMMAND_PROTOCOL_TYPE } from './hub/types';
export { writeAudit } from './services/audit.service';
export { resetTwoFactorByEmail } from './services/security.service';
export type { AuditEntry, AuditActorType } from './services/audit.service';
// Agent-binary release: the install routes serve these binaries and pin their
// checksums into the rendered installer.
export { agentRelease, agentBinaryPath } from './services/agent-release.service';
export type { AgentReleaseManifest } from './services/agent-release.service';
export * from './errors';

// ── REST front door: api-key→OrgContext seam + service functions it reuses ──
export { resolveOrgContextFromApiKey } from './apiKeyContext';
// The fine-grained policy step both front doors share (REST `requireAction`).
export {
  authorize,
  resolveNode,
  resolveService,
  resolveStack,
  resolveStackByName,
  resolveNewService,
  whoCan,
  canPrincipal,
  liveStackLabels,
} from './abac';
export type { AuthzGrant, ResolveResource, WhoCanRow } from './abac';
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
  setDomainWww,
  parseDomainId,
  reconcileColdIngress,
  reconcileIngressOrg,
  reapplyIngressForOrg,
} from './services/ingress.service';
export type { DomainView, IngressConfigView, IngressColdReconcileDeps } from './services/ingress.service';
// Wildcard certificates: ACME DNS-01 through swarmy's own nameservers (apps/api route).
export { acmeDnsRequest, getDnsChallengeView, setByoDnsProvider } from './services/acme-dns.service';
export type { DnsChallengeView } from './services/acme-dns.service';
// Custom domains: DNS verification + certificate status (domain-verify worker, REST).
export {
  getDomainStatus,
  reconcileDomainChecksOrg,
  skipDomainVerification,
  verifyDomainNow,
} from './services/domain-verify.service';
export type { DomainDetailView, DomainStatusView, DomainCheckReconcileResult } from './services/domain-verify.service';
export { domainChecksOf } from './services/domain-checks.store';
// Automatic app addresses (<service>-<stack>.<edge-ip>.sslip.io) — worker + plan-time helpers.
export {
  autoAddressBase,
  autoAddressFor,
  autoAddressLabels,
  reconcileAutoAddressesForOrg,
} from './services/auto-address.service';

// Observability suite convergence (observability-reconcile worker).
export {
  reconcileObservabilitySuite,
  recordStoreProbe,
  latestStoreProbe,
  type StoreProbe,
} from './services/observability.service';
// RUM (web analytics + session replay): the public /_rum ingest + retention sweep + replay links.
export { handleRumRequest, type RumIngestDeps } from './services/rum/rum-ingest';
export { sweepRumRetentionForOrg, type RetentionSweepResult } from './services/rum/rum-retention';
export { replayLinkFor } from './services/rum/rum-query';
// Garage store convergence (storage-reconcile worker).
export { convergeStoreDeployment, garageCapacityGb } from './services/replicatedStore.service';
export { gcPlatformKeys } from './services/platform-keys.service';

// ── git-cicd-registry P2: webhook + GC + build-log seams ──
export { buildLogBus } from './services/build-log-bus';
export {
  triggerBuildForRepo,
  systemContext,
  computeGcPlan,
  bareDigest,
} from './services/cicd.service';
export type { GcCandidate, GcPlan, GcPlanInput, BuildLogLine } from './services/cicd.service';
// ── git-apps P2: provider connections, JIT credentials, feedback ──
export {
  completeGithubManifest,
  completeGithubSetup,
  completeGitlabOAuth,
  // REST parity (/api/v1/git/*) — the same functions the gitConnections router calls.
  createConnection,
  getConnection,
  linkRepo,
  listConnections,
  listProviderBranches,
  listProviderRepos,
  removeConnection,
  updateRepo,
} from './services/git-connections.service';
export type {
  CreateConnectionInput,
  GitConnectionKind,
  GitConnectionView,
  LinkRepoInput,
  LinkedRepoView,
} from './services/git-connections.service';
export type { ProviderBranch, ProviderRepo } from './services/git-providers';
export { getRepo, listRepos, removeRepo } from './services/cicd.service';
export type { GitRepoKind, GitRepoView } from './services/cicd.service';
export { controllerPublicUrl, repoCredentials } from './services/git-credentials';
export { previewCommentBody, reportCommitStatus, upsertPrComment } from './services/git-feedback.service';
// ── git-apps P3: the GitOps apply loop ──
export {
  checkDriftNow,
  confirmAppActions,
  detectDrift,
  getPlan,
  handleBranchPush,
  isAppBinding,
  listAppBindingIds,
  listApps,
  listPlans,
  planCommit,
  pollApp,
  promoteEnvironment,
  purgeAppData,
  setEnforceDrift,
  planCommitForRepo,
  replan,
  setRequireApproval,
  teardownAppPreviewForRepo,
  teardownExpiredAppPreviews,
} from './services/apps.service';
export type { AppPlanView, AppView, PlanCommitInput, PlanCommitResult } from './services/apps.service';
export {
  runImageGcForOrg,
  runImageGcAllOrgs,
  computePinnedDigests,
} from './services/image-gc.service';
export type { GcRunResult } from './services/image-gc.service';
// Self-reliance B3/B4/B6: system-image mirror + Hub pull-through cache, Trivy DB cache refresh.
export { mirrorSystemImagesAllOrgs } from './services/system-images.service';
export type { MirrorTickResult } from './services/system-images.service';
export { ensureRegistryDeployed } from './services/cicd.service';
export { refreshTrivyDbAllOrgs } from './services/trivy-db.service';
// In-swarm registry auth: the hub dispatch decorator attaching pull creds to
// org-registry deploys (wired onto AgentHubImpl in apps/api).
export { createRegistryAuthDecorator } from './services/registry-auth';
export {
  deleteRegistryCredential,
  listRegistryCredentials,
  resolveBuildPullAuths,
  resolveRegistryAuthFor,
  testRegistryCredential,
  updateRegistryCredential,
  upsertRegistryCredential,
} from './services/registry-credentials.service';
export type { RegistryCredentialView, UpsertRegistryCredentialInput } from './services/registry-credentials.service';
export { REGISTRY_PROVIDERS } from './services/registry-credentials';
export type { RegistryProvider, RegistryTestResult, RegistryTestStatus } from './services/registry-credentials';

// ── data-store P1: controller-state backup/restore seams ──
export { isBackupDue, runControllerBackup } from './services/controllerBackup.service';
export { restoreBundle } from './services/controllerBackup.bundle';
export { setControllerStoreRuntime } from './services/controllerStore.service';
export type { ControllerStoreRuntime, ControllerStoreRuntimeStatus } from './services/controllerStore.service';
export { loadControlPlane, installSnapshotFile } from './services/controllerBackup.snapshot';

// ── node-onboarding P2: swarm init/join orchestration (gateway register seam) ──
export {
  orchestrateSwarmMembership,
  planSwarmMembership,
  primeSwarmJoinMaterial,
  swarmOrchestrationStatus,
  foreignSwarmDetail,
  retryPendingSwarmJoins,
  SWARM_COMMAND,
} from './services/swarm.service';
export type {
  OrchestrateArgs,
  OrchestrateOutcome,
  SwarmHub,
  SwarmDb,
  SwarmJoinMaterial,
  SwarmPeer,
  SwarmOrchestrationEvent,
} from './services/swarm.service';

// ── public-api-terraform P2 (Wave G1): REST CRUD service fns ──
export { listApiKeys, createApiKey, revokeApiKey } from './services/apiKeys.service';
export {
  setNodeAvailability,
  setNodeLabels,
  removeNode,
  stampReportedPublicIp,
  stampProfileLabels,
  stampDefaultBuilderRole,
  foreignSwarmOf,
} from './services/node.service';
// WS7 private-mesh profile: the register path auto-enrolls the node into the mesh.
export { enrollNode as enrollMeshNode } from './services/mesh.service';
// ── geo-dns ("swarmy is the nameserver"): worker + REST seams ──
export {
  listDnsView,
  checkDomain,
  reconcileDnsOrg,
  geoDnsEnabledOrgIds,
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
export { siblingSpecFrom } from './services/region.service';
export { liveServiceSpec } from './services/service-patch';
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
// Default-on DB backups (backup-scheduler worker) + the scheduled DB-backup
// sweep the manageddb-reconcile worker resolves off the package root.
export { ensureAutoBackups } from './services/autoBackup.service';
export { runScheduledAppDbDump } from './services/appDbBackup.service';
// Managed Postgres credentials: the reconcile migrates plain-env passwords onto Docker secrets.
export { migrateDbCredentials } from './services/manageddb.service';
// In-cluster restic destinations (native Garage) need the swarmy overlay — workers too.
export { resticNetworkFor } from './services/backups.service';
// Managed data node-pinning (cache/search/vector reconcile workers) + the
// canonical member spec builders those workers converge with.
export {
  reconcileDataPin,
  runningTaskSwarmNodes,
  isMultiNodeSwarm,
} from './services/data-pin';
export type { DataPinOutcome } from './services/data-pin';
export {
  cachePrimarySpec,
  cacheReplicaSpec,
  cacheRegionReplicaSpec,
  cacheSentinelSpec,
} from './services/cache.service';
export type { CacheClusterDecl } from './services/cache.service';
export { sampleQueueClusters, type SampledCluster } from './services/queue-studio.service';
export { runDueDbBackups } from './services/dbBackup.service';
export { runDueScheduledJobs } from './services/jobs.service';
export { managedKindOf, parseExposureRules } from './services/exposure.service';
export { readRoutes } from './services/ingress-routes';
export { selectRestoreTarget, type ReconcileNode } from './services/reconcile-target';
export { pruneAuditLogs } from './services/auditLog.service';
export { publicStatus, sampleUptimeTick } from './services/statusPages.service';
export {
  list as listClusterVolumes,
  register as registerClusterVolume,
  deregister as deregisterClusterVolume,
} from './services/clusterVolume.service';
export { mintSetupKeyForOrg } from './services/mesh.service';
export { meshPeers, reconcileMeshPeer } from './services/mesh-peers';
export type { LiveMeshPeer } from './services/mesh-peers';
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
// Error tracking (Sentry-compatible ingest, artifacts, spike sweep).
export * from './services/errors';
export { ensureDefaultRules } from './services/alerts.service';
export { runNodeHygieneAllOrgs } from './services/node-hygiene.service';
// Disk re-attach (QA-075b): the disk-reconcile worker's per-node check + the placement signal.
export { runDiskReconcileFor, unmountedDefaultDiskNodes, type DiskReconcileOutcome } from './services/disks.service';
export type { FireEventInput } from './services/alerts-fire';
export { recordIncidentEvent } from './services/incidents-record';
export { garageMajorOf, toGarageRequest, LEGACY_GARAGE_IMAGE, type GarageMajor } from './services/garage-admin';
export { resumeEngineUpgrade, readEngineUpgradeRun } from './services/engine-upgrade.service';
export { resumePlatformUpgrades, startPlatformUpgrade } from './services/platform-upgrade.service';
export { platformTick } from './services/platform-tick';

// ── swarm-kv: class-(b) infra config stored in the swarm (plans/epic-docker-native-state.md P4) ──
export {
  kvFor,
  swarmKvFor,
  useMemoryKv,
  seedKv,
  dropKvCache,
  exportKvForBundle,
  importKvFromBundle,
  stashPendingKv,
  importPendingKv,
  KV_COLLECTIONS,
  type KvBundleSection,
  type KvCollection,
  type KvScope,
} from './services/swarm-kv.service';
export { reachableOrgIds } from './services/kv-repo';
export { ingressConfigRepo, ingressEnabledOrgIds } from './services/ingress-config.repo';
export { meshConfigRepo } from './services/mesh-config.repo';
export { reconcileMeshControl, getControlPlaneCard, managedOf, renderControlSpec } from './services/mesh-control.service';
export type { ManagedControlPlane } from './services/mesh-control.service';
export { reconcilePeopleAccess, computePeopleIntent, liveStacks } from './services/mesh-people.service';
export { reconcileIntegrationsNetwork, integrationTargets, planIntegrations } from './services/integrations-network';
export { reconcileOrphanedWork } from './services/build-orphans.service';
export { gateSystemDeploy, isSystemOwned, SPEC_SIGNATURE_LABEL } from './services/system-service-deploy';
export { observabilityConfigRepo } from './services/observability-config.repo';
export { geoDnsConfigRepo, dnsZoneRepo } from './services/geodns.repo';
export { storageClusterRepo, bucketAccessRepo } from './services/storage-cluster.repo';
export {
  allOrgRows,
  backupTargets,
  backupSchedules,
  controllerBackupConfigRepo,
} from './services/backups.repo';
export { stacks, registryConfigs, imageGcPolicies } from './services/apps.repo';

// Protect my app (identity-aware proxy) + end-user auth users (dev-platform §2).
export * from './services/app-access.service';
export { appJwks, signAppJwt } from './services/app-access-tokens';

// ── email service (epic developer-platform §8) ──
export {
  sendWithApiKey,
  sendSystemEmail,
  ingestReport,
  ingestMtaLogLines,
  orgForInboundToken,
  EmailApiError,
  mtaEndpoint,
} from './services/email/runtime';
export { convergeMail } from './services/email/deploy';
export { startSmtpSink, smtpSubmit } from './services/email/smtp';
export { bounceHookPassword, safeEqual as emailSafeEqual } from './services/email/keys';
export { BOUNCE_HOOK_PORT, BOUNCE_HOOK_USER, MAIL_SERVICE } from './services/email/maddy';
export { setEmailLogStore, flushEmailLogs, port25Probe, domainCheck } from './services/email/store';
export { checkEmailDomain, probePort25, ensureAppEmailCredential } from './services/email.service';
export { observabilityStore, orgErrorRates, type ServiceErrorRate } from './services/observability.service';
