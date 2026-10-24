import type { DemoHandler, DemoStore, DemoSubHandler, DomainResolvers } from './types';
import { core } from './resolvers/core';
import { inventory } from './resolvers/inventory';
import { ingress } from './resolvers/ingress';
import { cicd } from './resolvers/cicd';
import { cicdRegistryUsage } from './resolvers/cicd-registry-usage';
import { gitconnections } from './resolvers/gitconnections';
import { gitconnectionsGitea } from './resolvers/gitconnections-gitea';
import { apps } from './resolvers/apps';
import { mesh } from './resolvers/mesh';
import { observability } from './resolvers/observability';
import { errors } from './resolvers/errors';
import { geo } from './resolvers/geo';
import { clusterZone } from './resolvers/cluster-zone';
import { data } from './resolvers/data';
import { backupHistory } from './resolvers/backup-history';
import { access } from './resolvers/access';
import { infraextra } from './resolvers/infraextra';
import { cache } from './resolvers/cache';
import { buckets } from './resolvers/buckets';
import { bucketRules } from './resolvers/bucket-rules';
import { queues } from './resolvers/queues';
import { appaccess } from './resolvers/appaccess';
import { jobs } from './resolvers/jobs';
import { webhookgw } from './resolvers/webhookgw';
import { alerts } from './resolvers/alerts';
import { alertsDisk } from './resolvers/alerts-disk';
import { nodeStatsHistory } from './resolvers/node-stats-history';
import { incidents } from './resolvers/incidents';
import { statuspages } from './resolvers/statuspages';
import { releases } from './resolvers/releases';
import { registrypolicy } from './resolvers/registrypolicy';
import { registrycreds } from './resolvers/registrycreds';
import { secretsmgr } from './resolvers/secretsmgr';
import { configsmgr } from './resolvers/configsmgr';
import { exposure } from './resolvers/exposure';
import { guardrails } from './resolvers/guardrails';
import { guardrailsTally } from './resolvers/guardrails-tally';
import { auditlog } from './resolvers/auditlog';
import { cost } from './resolvers/cost';
import { resilience } from './resolvers/resilience';
import { resilienceLive } from './resolvers/resilience-live';
import { dbRestoreCopy } from './resolvers/db-restore-copy';
import { controllerstore } from './resolvers/controllerstore';
import { platform } from './resolvers/platform';
import { blueprints } from './resolvers/blueprints';
import { searchsvc } from './resolvers/searchsvc';
import { searchsvcIndexes } from './resolvers/searchsvc-indexes';
import { searchsvcKey } from './resolvers/searchsvc-key';
import { vector } from './resolvers/vector';
import { ai } from './resolvers/ai';
import { aiCache } from './resolvers/ai-cache';
import { email } from './resolvers/email';
import { security } from './resolvers/security';
import { rum } from './resolvers/rum';
import { studio } from './resolvers/studio';
import { pgExtensions } from './resolvers/pg-extensions';
import { studioSlow } from './resolvers/studio-slow';
import { gaps } from './resolvers/gaps';
import { serviceSettings } from './resolvers/service-settings';
import { serviceHealth } from './resolvers/service-health';
import { deployEvents } from './resolvers/deploy-events';
import { firstLook } from './resolvers/first-look';
import { inviteLinks } from './resolvers/invite-links';
import { invitePreview } from './resolvers/invite-preview';
import { traffic } from './resolvers/traffic';
import { stackLinks } from './resolvers/stack-links';
import { scaling } from './resolvers/scaling';
import { movesDemo } from './resolvers/moves';
import { meshGrants } from './resolvers/mesh-grants';
import { meshMtu } from './resolvers/mesh-mtu';
import { phoneHome } from './resolvers/phone-home';
import { placementDemo } from './resolvers/placement-demo';
import { jobsYesterday } from './resolvers/jobs-yesterday';
import { appEnvironments } from './resolvers/app-environments';
import { appPreviews } from './resolvers/app-previews';
import { edgeGeoip } from './resolvers/edge-geoip';
import { appsConfigFile } from './resolvers/apps-config-file';
import { appClone } from './resolvers/app-clone';
import { appsConvert } from './resolvers/apps-convert';

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
  cicdRegistryUsage,
  gitconnections,
  gitconnectionsGitea,
  apps,
  mesh,
  observability,
  errors,
  geo,
  clusterZone,
  data,
  backupHistory,
  access,
  infraextra,
  cache,
  buckets,
  bucketRules,
  queues,
  appaccess,
  jobs,
  webhookgw,
  alerts,
  alertsDisk,
  nodeStatsHistory,
  incidents,
  statuspages,
  releases,
  registrypolicy,
  registrycreds,
  secretsmgr,
  configsmgr,
  exposure,
  guardrails,
  guardrailsTally,
  auditlog,
  cost,
  resilience,
  resilienceLive,
  dbRestoreCopy,
  controllerstore,
  platform,
  blueprints,
  searchsvc,
  searchsvcIndexes,
  searchsvcKey,
  vector,
  ai,
  aiCache,
  email,
  security,
  studio,
  pgExtensions,
  studioSlow,
  rum,
  gaps,
  serviceSettings,
  serviceHealth,
  deployEvents,
  firstLook,
  inviteLinks,
  invitePreview,
  traffic,
  stackLinks,
  scaling,
  movesDemo,
  meshGrants,
  meshMtu,
  // Wraps core's nodes.list and infraextra's generateJoinToken, so it comes after both.
  phoneHome,
  placementDemo,
  jobsYesterday,
  appEnvironments,
  appPreviews,
  edgeGeoip,
  appsConfigFile,
  // Wraps apps' apps.list (clones marked as the dashboard's), so it comes after it.
  appClone,
  appsConvert,
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
