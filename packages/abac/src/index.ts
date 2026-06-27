export { PolicyEngine, JsonPolicyEngine, type IPolicyEngine } from './engine';
export { CedarPolicyEngine, tryCreateCedarEngine, policyDocToCedar } from './cedar';
export { createEngine, selectedEngineKind, type EngineKind } from './factory';
export {
  parsePolicyDoc,
  policyMatches,
  PolicyParseError,
  type PolicyDoc,
  type ParsedPolicy,
} from './policy';
export {
  resolveRelations,
  expandRelations,
  withRelations,
  type GrantEdge,
} from './grants';
export {
  buildPrincipal,
  buildResource,
  type PrincipalInput,
  type ResourceInput,
} from './build';
export { DEFAULT_POLICY_SPECS, defaultPolicyInputs } from './defaults';
export {
  ACTIONS,
  isAction,
  type Action,
  type Role,
  type Relation,
  type Principal,
  type Resource,
  type DecisionContext,
  type AuthzRequest,
  type Effect,
  type PolicyInput,
  type Decision,
} from './types';

// Convenience alias requested by the epic.
export { DEFAULT_POLICY_SPECS as DEFAULT_POLICIES } from './defaults';
