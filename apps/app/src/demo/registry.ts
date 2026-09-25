import type { DemoHandler, DemoStore, DemoSubHandler, DomainResolvers } from './types';
import { core } from './resolvers/core';
import { inventory } from './resolvers/inventory';
import { ingress } from './resolvers/ingress';
import { cicd } from './resolvers/cicd';
import { gitconnections } from './resolvers/gitconnections';
import { apps } from './resolvers/apps';
import { mesh } from './resolvers/mesh';
import { observability } from './resolvers/observability';
import { errors } from './resolvers/errors';
import { geo } from './resolvers/geo';
import { data } from './resolvers/data';
import { access } from './resolvers/access';
import { infraextra } from './resolvers/infraextra';
import { cache } from './resolvers/cache';
import { buckets } from './resolvers/buckets';
import { queues } from './resolvers/queues';
import { appaccess } from './resolvers/appaccess';
import { jobs } from './resolvers/jobs';
import { webhookgw } from './resolvers/webhookgw';
import { alerts } from './resolvers/alerts';
import { incidents } from './resolvers/incidents';
import { statuspages } from './resolvers/statuspages';
import { releases } from './resolvers/releases';
import { registrypolicy } from './resolvers/registrypolicy';
import { registrycreds } from './resolvers/registrycreds';
import { secretsmgr } from './resolvers/secretsmgr';
import { configsmgr } from './resolvers/configsmgr';
import { exposure } from './resolvers/exposure';
import { guardrails } from './resolvers/guardrails';
import { auditlog } from './resolvers/auditlog';
import { cost } from './resolvers/cost';
import { resilience } from './resolvers/resilience';
import { controllerstore } from './resolvers/controllerstore';
import { platform } from './resolvers/platform';
import { blueprints } from './resolvers/blueprints';
import { searchsvc } from './resolvers/searchsvc';
import { vector } from './resolvers/vector';
import { ai } from './resolvers/ai';
import { email } from './resolvers/email';
import { security } from './resolvers/security';
import { rum } from './resolvers/rum';
import { studio } from './resolvers/studio';
import { gaps } from './resolvers/gaps';

/**
 * Assembles every per-domain resolver module into flat lookup tables for the demo
 * link. Add a new domain by importing its module and listing it in MODULES — its
 * handlers/subscriptions/seed merge in automatically.
 */
const MODULES: DomainResolvers[] = [
  core,
  inventory,
  ingress,
  cicd,
  gitconnections,
  apps,
  mesh,
  observability,
  errors,
  geo,
  data,
  access,
  infraextra,
  cache,
  buckets,
  queues,
  appaccess,
  jobs,
  webhookgw,
  alerts,
  incidents,
  statuspages,
  releases,
  registrypolicy,
  registrycreds,
  secretsmgr,
  configsmgr,
  exposure,
  guardrails,
  auditlog,
  cost,
  resilience,
  controllerstore,
  platform,
  blueprints,
  searchsvc,
  vector,
  ai,
  email,
  security,
  studio,
  rum,
  gaps,
];

export const HANDLERS: Record<string, DemoHandler> = Object.assign(
  {},
  ...MODULES.map((m) => m.handlers ?? {}),
);

export const SUBSCRIPTIONS: Record<string, DemoSubHandler> = Object.assign(
  {},
  ...MODULES.map((m) => m.subscriptions ?? {}),
);

export const SEEDS: Array<(store: DemoStore) => void> = MODULES.map((m) => m.seed).filter(
  (s): s is (store: DemoStore) => void => typeof s === 'function',
);
