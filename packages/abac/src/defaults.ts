import type { PolicyInput } from './types';
import type { PolicyDoc } from './policy';

interface DefaultPolicySpec {
  key: string; // stable identifier, also the seeded policy name
  name: string;
  effect: 'permit' | 'forbid';
  priority: number;
  doc: PolicyDoc;
}

/** Outside production: the env is anything but `production`, or unknown. */
export const NON_PRODUCTION = { attr: 'resource.env', op: 'ne', value: 'production' } as const;

/**
 * The seeded default policy set (the attribute-based model, owner direction
 * 2026-09-24 — "members: more attribute-based permissions"):
 *
 *  - owner/admin may do everything;
 *  - members read everything;
 *  - members deploy, configure, scale and restart freely OUTSIDE production
 *    (`resource.env ne production`: an unlabelled app, or an org-scoped call
 *    with no resource, counts as non-production). Production is the
 *    `swarmy.env=production` Docker label;
 *  - members may join the mesh of NON-production stacks (`mesh.connect`);
 *  - a production deploy or mesh connect, every destructive action (`data.*`,
 *    `*.remove`, `secret.delete`, …), `terminal.open` and `secrets.read` need
 *    an explicit grant: a policy naming the member's group / the member, or a
 *    `ResourceGrant` operator/owner edge on that resource.
 *
 * Effects compose forbid-wins; among permits the highest priority wins for audit.
 * Defaults are managed: when this set changes, every org's stored default rows
 * are rewritten to match on its next decision (policy-repo `ensureDefaults`);
 * custom rules are untouched.
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
    name: 'Members can deploy and operate outside production',
    effect: 'permit',
    priority: 40,
    doc: {
      roles: ['member'],
      actions: [
        'node.drain',
        'node.setLabels',
        'service.deploy',
        'service.configure',
        'service.scale',
        'service.restart',
        'stack.deploy',
        'ingress.write',
      ],
      conditions: [{ ...NON_PRODUCTION }],
    },
  },
  {
    key: 'member-mesh-nonprod',
    name: 'Members can connect to non-production stacks',
    effect: 'permit',
    priority: 38,
    doc: { roles: ['member'], actions: ['mesh.connect'], conditions: [{ ...NON_PRODUCTION }] },
  },
  {
    // ReBAC: a member granted `operator` (or `owner`) on a specific resource may
    // run safe ops on *that* resource — production included. The explicit-grant
    // path for "this person may deploy the prod storefront".
    key: 'operator-resource-ops',
    name: 'Resource operators can operate their resources',
    effect: 'permit',
    priority: 45,
    doc: {
      relations: ['operator', 'owner'],
      actions: [
        'service.deploy',
        'service.configure',
        'service.scale',
        'service.restart',
        'stack.deploy',
        'node.drain',
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
