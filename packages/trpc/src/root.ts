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
});

export type AppRouter = typeof appRouter;
