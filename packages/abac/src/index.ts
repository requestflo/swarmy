export { PolicyEngine } from './engine';
export {
  parsePolicyDoc,
  policyMatches,
  PolicyParseError,
  type PolicyDoc,
  type ParsedPolicy,
} from './policy';
export { DEFAULT_POLICY_SPECS, defaultPolicyInputs } from './defaults';
export {
  ACTIONS,
  isAction,
  type Action,
  type Role,
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
