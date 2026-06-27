import type { PolicyInput } from './types';
import type { PolicyDoc } from './policy';

interface DefaultPolicySpec {
  key: string; // stable identifier, also the seeded policy name
  name: string;
  effect: 'permit' | 'forbid';
  priority: number;
  doc: PolicyDoc;
}

/**
 * The seeded, behaviour-preserving policy set written for every org on create.
 * Reproduces today's `owner | admin | member` semantics exactly, so an org that
 * never opens the policy UI behaves precisely as it does today:
 *
 *  - owner/admin may do everything (admin == "not a member" today);
 *  - member may read everything + take safe service actions (drain/scale/restart);
 *  - destructive + governance actions require admin/owner.
 *
 * Effects compose forbid-wins; among permits the highest priority wins for audit.
 */
export const DEFAULT_POLICY_SPECS: DefaultPolicySpec[] = [
  {
    key: 'owner-superuser',
    name: 'Owners can do anything',
    effect: 'permit',
    priority: 100,
    doc: { roles: ['owner'], actions: ['*'] },
  },
  {
    key: 'admin-superuser',
    name: 'Admins can do anything',
    effect: 'permit',
    priority: 90,
    doc: { roles: ['admin'], actions: ['*'] },
  },
  {
    key: 'member-read',
    name: 'Members can read',
    effect: 'permit',
    priority: 50,
    doc: {
      roles: ['member'],
      actions: [
        'node.read',
        'service.read',
        'stack.read',
        'ingress.read',
        'member.read',
        'policy.read',
        'authconfig.read',
      ],
    },
  },
  {
    key: 'member-safe-ops',
    name: 'Members can run safe operations',
    effect: 'permit',
    priority: 40,
    doc: {
      roles: ['member'],
      actions: [
        'node.drain',
        'node.setLabels',
        'service.deploy',
        'service.scale',
        'service.restart',
        'stack.deploy',
        'ingress.write',
      ],
    },
  },
];

/** The default policies as {@link PolicyInput} rows for the engine (no DB ids). */
export function defaultPolicyInputs(): Array<Omit<PolicyInput, 'id'> & { key: string }> {
  return DEFAULT_POLICY_SPECS.map((spec) => ({
    key: spec.key,
    name: spec.name,
    effect: spec.effect,
    priority: spec.priority,
    enabled: true,
    source: JSON.stringify(spec.doc),
  }));
}
