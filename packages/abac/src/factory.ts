import type { PolicyInput } from './types';
import { JsonPolicyEngine, type IPolicyEngine } from './engine';
import { tryCreateCedarEngine } from './cedar';

export type EngineKind = 'json' | 'cedar';

/**
 * The active engine selector. Defaults to `json` (zero-dependency, the documented
 * fallback shape). Set `ABAC_ENGINE=cedar` to opt into the Cedar path; if
 * `@cedar-policy/cedar-wasm` is not installed, we transparently fall back to JSON
 * so the controller never fails to make a decision.
 */
export function selectedEngineKind(): EngineKind {
  return process.env.ABAC_ENGINE === 'cedar' ? 'cedar' : 'json';
}

/**
 * Build a policy engine for the given policy set. Async because the Cedar path
 * may need to load the WASM module. The JSON path resolves synchronously inside
 * the promise. Callers that only ever use JSON can use {@link JsonPolicyEngine}
 * directly.
 */
export async function createEngine(
  policies: PolicyInput[],
  kind: EngineKind = selectedEngineKind(),
): Promise<IPolicyEngine> {
  if (kind === 'cedar') {
    const cedar = await tryCreateCedarEngine(policies);
    if (cedar) return cedar;
  }
  return new JsonPolicyEngine(policies);
}
