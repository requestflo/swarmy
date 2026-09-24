import { router } from './trpc';
import { orgRouter } from './routers/org';
import { nodesRouter } from './routers/nodes';
import { servicesRouter } from './routers/services';
import { stacksRouter } from './routers/stacks';
import { estateRouter } from './routers/estate';
import { ingressRouter } from './routers/ingress';
import { appAccessRouter } from './routers/appAccess';
import { backupsRouter } from './routers/backups';
import { offsiteMirrorRouter } from './routers/offsiteMirror';
import { dbBackupRouter } from './routers/dbBackup';
import { observabilityRouter } from './routers/observability';
import { errorsRouter } from './routers/errors';
import { meshRouter } from './routers/mesh';
import { imagesRouter } from './routers/images';
import { builderRouter } from './routers/builder';
import { authConfigRouter } from './routers/authConfig';
import { policiesRouter } from './routers/policies';
import { terminalRouter } from './routers/terminal';
import { cicdRouter } from './routers/cicd';
import { gitConnectionsRouter } from './routers/gitConnections';
import { appsRouter } from './routers/apps';
import { geodnsRouter } from './routers/geodns';
import { apiKeysRouter } from './routers/apiKeys';
import { controllerBackupRouter } from './routers/controllerBackup';
import { controllerStoreRouter } from './routers/controllerStore';
import { storageRouter } from './routers/storage';
import { platformRouter } from './routers/platform';
import { volumesRouter } from './routers/volumes';
import { decommissionRouter } from './routers/decommission';
import { schedulesRouter } from './routers/schedules';
import { ssoRouter } from './routers/sso';
import { securityRouter } from './routers/security';
import { membersRouter } from './routers/members';
import { oauthRouter } from './routers/oauth';
import { webhooksOutRouter } from './routers/webhooksOut';
import { inventoryRouter } from './routers/inventory';
import { regionRouter } from './routers/region';
import { managedDbRouter } from './routers/manageddb';
// ── platform buildout spine (see plans/platform-buildout-manifest.md) ──
import { managedCacheRouter } from './routers/cache';
import { objectStorageRouter } from './routers/buckets';
import { queuesRouter } from './routers/queues';
import { jobsRouter } from './routers/jobs';
import { workflowEngineRouter } from './routers/workflows';
import { inboundWebhooksRouter } from './routers/inboundWebhooks';
import { alertsRouter } from './routers/alerts';
import { incidentsRouter } from './routers/incidents';
import { statusPagesRouter } from './routers/statusPages';
import { releasesRouter } from './routers/releases';
import { registryPolicyRouter } from './routers/registryPolicy';
import { registryCredentialsRouter } from './routers/registryCredentials';
import { previewsRouter } from './routers/previews';
import { secretsMgrRouter } from './routers/secretsMgr';
import { configsMgrRouter } from './routers/configsMgr';
import { exposureRouter } from './routers/exposure';
import { guardrailsRouter } from './routers/guardrails';
import { auditLogRouter } from './routers/auditLog';
import { costRouter } from './routers/cost';
import { resilienceRouter } from './routers/resilience';
import { swarmRouter } from './routers/swarm';
import { blueprintsRouter } from './routers/blueprints';
import { managedSearchRouter } from './routers/search';
import { vectorStoreRouter } from './routers/vector';
import { aiGatewayRouter } from './routers/ai';
import { notificationsRouter } from './routers/notifications';
import { studioRouter } from './routers/studio';
import { emailRouter } from './routers/email';
import { rumRouter } from './routers/rum';

export const appRouter = router({
  org: orgRouter,
  inventory: inventoryRouter,
  region: regionRouter,
  db: managedDbRouter,
  nodes: nodesRouter,
  decommission: decommissionRouter,
  services: servicesRouter,
  stacks: stacksRouter,
  estate: estateRouter,
  ingress: ingressRouter,
  appAccess: appAccessRouter,
  backups: backupsRouter,
  offsiteMirror: offsiteMirrorRouter,
  dbBackups: dbBackupRouter,
  observability: observabilityRouter,
  rum: rumRouter,
  errors: errorsRouter,
  mesh: meshRouter,
  images: imagesRouter,
  builder: builderRouter,
  authConfig: authConfigRouter,
  policies: policiesRouter,
  terminal: terminalRouter,
  cicd: cicdRouter,
  gitConnections: gitConnectionsRouter,
  apps: appsRouter,
  geodns: geodnsRouter,
  apiKeys: apiKeysRouter,
  controllerBackup: controllerBackupRouter,
  controllerStore: controllerStoreRouter,
  storage: storageRouter,
  platform: platformRouter,
  volumes: volumesRouter,
  schedules: schedulesRouter,
  sso: ssoRouter,
  security: securityRouter,
  members: membersRouter,
  oauth: oauthRouter,
  webhooksOut: webhooksOutRouter,
  // ── platform buildout spine (see plans/platform-buildout-manifest.md) ──
  cache: managedCacheRouter,
  buckets: objectStorageRouter,
  queues: queuesRouter,
  jobs: jobsRouter,
  workflows: workflowEngineRouter,
  inboundWebhooks: inboundWebhooksRouter,
  alerts: alertsRouter,
  incidents: incidentsRouter,
  statusPages: statusPagesRouter,
  releases: releasesRouter,
  registryPolicy: registryPolicyRouter,
  registryCredentials: registryCredentialsRouter,
  previews: previewsRouter,
  secrets: secretsMgrRouter,
  configs: configsMgrRouter,
  exposure: exposureRouter,
  guardrails: guardrailsRouter,
  audit: auditLogRouter,
  cost: costRouter,
  resilience: resilienceRouter,
  swarm: swarmRouter,
  blueprints: blueprintsRouter,
  search: managedSearchRouter,
  vector: vectorStoreRouter,
  ai: aiGatewayRouter,
  notifications: notificationsRouter,
  studio: studioRouter,
  email: emailRouter,
});

export type AppRouter = typeof appRouter;
