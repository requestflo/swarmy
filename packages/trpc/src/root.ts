import { router } from './trpc';
import { orgRouter } from './routers/org';
import { nodesRouter } from './routers/nodes';
import { servicesRouter } from './routers/services';
import { stacksRouter } from './routers/stacks';
import { deploymentsRouter } from './routers/deployments';
import { metricsRouter } from './routers/metrics';
import { ingressRouter } from './routers/ingress';
import { systemRouter } from './routers/system';
import { backupsRouter } from './routers/backups';
import { dbBackupRouter } from './routers/dbBackup';
import { observabilityRouter } from './routers/observability';
import { meshRouter } from './routers/mesh';
import { imagesRouter } from './routers/images';
import { builderRouter } from './routers/builder';
import { authConfigRouter } from './routers/authConfig';
import { policiesRouter } from './routers/policies';
import { terminalRouter } from './routers/terminal';
import { cicdRouter } from './routers/cicd';
import { geodnsRouter } from './routers/geodns';
import { templatesRouter } from './routers/templates';
import { apiKeysRouter } from './routers/apiKeys';
import { controllerBackupRouter } from './routers/controllerBackup';
import { storageRouter } from './routers/storage';
import { volumesRouter } from './routers/volumes';
import { schedulesRouter } from './routers/schedules';
import { ssoRouter } from './routers/sso';
import { membersRouter } from './routers/members';
import { oauthRouter } from './routers/oauth';
import { webhooksOutRouter } from './routers/webhooksOut';
import { canvasRouter } from './routers/canvas';
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
import { previewsRouter } from './routers/previews';
import { secretsMgrRouter } from './routers/secretsMgr';
import { configsMgrRouter } from './routers/configsMgr';
import { exposureRouter } from './routers/exposure';
import { guardrailsRouter } from './routers/guardrails';
import { auditLogRouter } from './routers/auditLog';
import { costRouter } from './routers/cost';
import { resilienceRouter } from './routers/resilience';
import { blueprintsRouter } from './routers/blueprints';
import { managedSearchRouter } from './routers/search';
import { vectorStoreRouter } from './routers/vector';
import { aiGatewayRouter } from './routers/ai';
import { notificationsRouter } from './routers/notifications';

export const appRouter = router({
  org: orgRouter,
  inventory: inventoryRouter,
  region: regionRouter,
  db: managedDbRouter,
  nodes: nodesRouter,
  services: servicesRouter,
  stacks: stacksRouter,
  deployments: deploymentsRouter,
  metrics: metricsRouter,
  ingress: ingressRouter,
  system: systemRouter,
  backups: backupsRouter,
  dbBackups: dbBackupRouter,
  observability: observabilityRouter,
  mesh: meshRouter,
  images: imagesRouter,
  builder: builderRouter,
  authConfig: authConfigRouter,
  policies: policiesRouter,
  terminal: terminalRouter,
  cicd: cicdRouter,
  geodns: geodnsRouter,
  templates: templatesRouter,
  apiKeys: apiKeysRouter,
  controllerBackup: controllerBackupRouter,
  storage: storageRouter,
  volumes: volumesRouter,
  schedules: schedulesRouter,
  sso: ssoRouter,
  members: membersRouter,
  oauth: oauthRouter,
  webhooksOut: webhooksOutRouter,
  canvas: canvasRouter,
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
  previews: previewsRouter,
  secrets: secretsMgrRouter,
  configs: configsMgrRouter,
  exposure: exposureRouter,
  guardrails: guardrailsRouter,
  audit: auditLogRouter,
  cost: costRouter,
  resilience: resilienceRouter,
  blueprints: blueprintsRouter,
  search: managedSearchRouter,
  vector: vectorStoreRouter,
  ai: aiGatewayRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
