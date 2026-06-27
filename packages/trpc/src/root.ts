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

export const appRouter = router({
  org: orgRouter,
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
});

export type AppRouter = typeof appRouter;
