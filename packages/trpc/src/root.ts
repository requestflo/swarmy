import { router } from './trpc';
import { orgRouter } from './routers/org';
import { nodesRouter } from './routers/nodes';
import { servicesRouter } from './routers/services';
import { stacksRouter } from './routers/stacks';
import { deploymentsRouter } from './routers/deployments';
import { metricsRouter } from './routers/metrics';
import { ingressRouter } from './routers/ingress';
import { systemRouter } from './routers/system';

export const appRouter = router({
  org: orgRouter,
  nodes: nodesRouter,
  services: servicesRouter,
  stacks: stacksRouter,
  deployments: deploymentsRouter,
  metrics: metricsRouter,
  ingress: ingressRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
