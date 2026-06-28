import type { DemoHandler, DemoStore, DemoSubHandler, DomainResolvers } from './types';
import { core } from './resolvers/core';
import { ingress } from './resolvers/ingress';
import { cicd } from './resolvers/cicd';
import { mesh } from './resolvers/mesh';
import { observability } from './resolvers/observability';
import { geo } from './resolvers/geo';
import { data } from './resolvers/data';
import { access } from './resolvers/access';
import { infraextra } from './resolvers/infraextra';

/**
 * Assembles every per-domain resolver module into flat lookup tables for the demo
 * link. Add a new domain by importing its module and listing it in MODULES — its
 * handlers/subscriptions/seed merge in automatically.
 */
const MODULES: DomainResolvers[] = [
  core,
  ingress,
  cicd,
  mesh,
  observability,
  geo,
  data,
  access,
  infraextra,
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
