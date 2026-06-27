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
});

export type AppRouter = typeof appRouter;
