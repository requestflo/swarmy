export { appRouter, type AppRouter } from './root';
export { createContext } from './context';
export type { BaseContext, AuthedContext, OrgContext, CreateContextOptions } from './context';
export type {
  AgentHub,
  CommandName,
  CommandResult,
} from './hub/types';
export { COMMAND_PROTOCOL_TYPE } from './hub/types';
export { writeAudit } from './services/audit.service';
export type { AuditEntry, AuditActorType } from './services/audit.service';
export * from './errors';

// ── REST front door: api-key→OrgContext seam + service functions it reuses ──
export { resolveOrgContextFromApiKey } from './apiKeyContext';
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
export { addDomain, listDomains, removeDomain } from './services/ingress.service';
export type { DomainView, IngressConfigView } from './services/ingress.service';

// ── git-cicd-registry P2: webhook + GC + build-log seams ──
export { buildLogBus } from './services/build-log-bus';
export {
  triggerBuildForRepo,
  autodeployBuilt,
  systemContext,
  computeGcPlan,
  bareDigest,
} from './services/cicd.service';
export type { GcCandidate, GcPlan, GcPlanInput, BuildLogLine } from './services/cicd.service';
export {
  runImageGcForOrg,
  runImageGcAllOrgs,
  computePinnedDigests,
} from './services/image-gc.service';
export type { GcRunResult } from './services/image-gc.service';

// ── data-store P1: controller-state backup/restore seams ──
export { isBackupDue, runControllerBackup } from './services/controllerBackup.service';
export { restoreBundle } from './services/controllerBackup.bundle';
export { loadControlPlane } from './services/controllerBackup.dump';
