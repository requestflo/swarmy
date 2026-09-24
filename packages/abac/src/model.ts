/**
 * Browser-safe entry: the policy model, the JSON engine, defaults and the
 * plain-words renderer — without the Cedar adapter (its optional dynamic
 * import of `@cedar-policy/cedar-wasm` must not reach a bundler). The dashboard
 * imports `@swarmy/abac/model`; the controller uses the full index.
 */
export { JsonPolicyEngine, type IPolicyEngine } from './engine';
export { parsePolicyDoc, policyMatches, PolicyParseError, type PolicyDoc, type ParsedPolicy } from './policy';
export { buildPrincipal, buildResource, type PrincipalInput, type ResourceInput } from './build';
export { DEFAULT_POLICY_SPECS, defaultPolicyInputs, NON_PRODUCTION } from './defaults';
export {
  ENV_LABEL,
  APP_ENV_LABEL,
  PRODUCTION,
  CONDITION_OPS,
  normaliseEnv,
  resourceEnv,
  principalGroups,
  groupsFromAttributes,
  lookupAttr,
  conditionHolds,
  isAttrPath,
  type Condition,
  type ConditionOp,
} from './attrs';
export { ACTION_CATALOG, actionLabel, describePolicy, describeCondition, type ActionInfo } from './describe';
export { ACTIONS, isAction, type Action, type Role, type Principal, type Resource, type PolicyInput } from './types';
