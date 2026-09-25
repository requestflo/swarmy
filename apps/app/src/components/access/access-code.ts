import type { CodeTab } from '@/components/calm';
import type { SignInMethod } from './use-signin-methods';
import type { PolicyRow } from './use-policy-editor';

function doc(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return source;
  }
}

/** The rules as the policy documents the engine runs (JSON, Cedar-compatible), and the sign-in set. */
export function accessCode(rules: PolicyRow[], methods: SignInMethod[]): CodeTab[] {
  const policies = rules.map((r) => ({ id: r.id, name: r.name, effect: r.effect, priority: r.priority, enabled: r.enabled, default: r.isDefault, policy: doc(r.source) }));
  return [
    { label: 'policy JSON', code: JSON.stringify(policies, null, 2) },
    { label: 'sign-in', code: JSON.stringify(methods.map((m) => ({ method: m.label, kind: m.kind, enabled: m.enabled })), null, 2) },
  ];
}
