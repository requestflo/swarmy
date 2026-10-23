import { JsonPolicyEngine } from './engine';
import { buildPrincipal, buildResource } from './build';
import type { GrantEdge } from './grants';
import type { Action, PolicyInput, Resource, Role } from './types';

/**
 * "They can / They can't / Blocked by policy" for someone who isn't in the org
 * yet: a hypothetical principal (a role, plus an `operator` grant on each app
 * the invite names) evaluated against the org's real policy set for a fixed
 * list of plain-words abilities. Pure: the caller loads the policies and the
 * org's apps (with their live labels); nothing here touches a DB or Docker.
 *
 * Each ability is evaluated on the resource type its real gate resolves:
 * deploys on the app (stack), restarts / logs / shells / domains on a part
 * (service) of the app, people and data on the workspace. A stack grant only
 * reaches stack-level actions, exactly as the gate decides. Uses the JSON
 * engine, which decides identically to Cedar for every supported document.
 */

export type InviteAbilityKey = 'deploy' | 'restart' | 'logs' | 'shell' | 'domains' | 'people' | 'data';

export interface InviteAbility {
  key: InviteAbilityKey;
  /** Plain words: "deploy", "see logs". */
  label: string;
  action: Action;
  /** What the real gate evaluates the action on. */
  on: 'stack' | 'service' | 'org';
}

export const INVITE_ABILITIES: readonly InviteAbility[] = [
  { key: 'deploy', label: 'deploy', action: 'stack.deploy', on: 'stack' },
  { key: 'restart', label: 'restart', action: 'service.restart', on: 'service' },
  { key: 'logs', label: 'see logs', action: 'service.read', on: 'service' },
  { key: 'shell', label: 'open a shell', action: 'terminal.open', on: 'service' },
  { key: 'domains', label: 'change domains', action: 'ingress.write', on: 'service' },
  { key: 'people', label: 'manage people', action: 'member.write', on: 'org' },
  { key: 'data', label: 'delete data', action: 'data.destroy', on: 'org' },
];

/** One app of the org: its grant id (stack row id, else name) and live labels. */
export interface InviteApp {
  id: string;
  name: string;
  labels?: Record<string, unknown> | null;
}

export interface InviteCandidate {
  orgId: string;
  role: Role;
  /** App ids the invite grants `operator` on. Ignored for owners and admins. */
  grantedAppIds: string[];
}

export interface InviteVerdict {
  key: InviteAbilityKey;
  label: string;
  action: Action;
  on: InviteAbility['on'];
  /** Permitted on every app (or on the workspace) · on some · on none. */
  reach: 'all' | 'some' | 'none';
  /** App names it is permitted / denied on (empty for workspace abilities). */
  allowedOn: string[];
  deniedOn: string[];
  /** The rule that permits it (where it is permitted). */
  permitBy: { id: string; name: string } | null;
  /** A forbid rule that blocks it somewhere: "Blocked by policy …". */
  blockedBy: { id: string; name: string } | null;
}

/** The invitee's stand-in member id: no real grant row can match it. */
export const INVITEE_MEMBER_ID = '(invitee)';

function ruleRef(policies: Map<string, PolicyInput>, id: string | null): { id: string; name: string } | null {
  if (!id) return null;
  return { id, name: policies.get(id)?.name ?? id };
}

export function simulateInvite(policies: PolicyInput[], who: InviteCandidate, apps: InviteApp[]): InviteVerdict[] {
  const engine = new JsonPolicyEngine(policies);
  const byId = new Map(policies.map((p) => [p.id, p]));
  const principal = buildPrincipal({ userId: INVITEE_MEMBER_ID, orgId: who.orgId, role: who.role, memberId: INVITEE_MEMBER_ID });
  const grants: GrantEdge[] =
    who.role === 'member'
      ? who.grantedAppIds.map((id) => ({ principalType: 'member', principalId: INVITEE_MEMBER_ID, resourceType: 'stack', resourceId: id, relation: 'operator' }))
      : [];
  // No apps yet: judge against a brand-new, unlabelled app.
  const targets: InviteApp[] = apps.length ? apps : [{ id: '(new app)', name: '', labels: {} }];

  return INVITE_ABILITIES.map((ability) => {
    const resources: Array<{ name: string; resource: Resource | null }> =
      ability.on === 'org'
        ? [{ name: '', resource: null }]
        : targets.map((app) => ({
            name: app.name,
            resource: buildResource(
              ability.on === 'stack'
                ? { type: 'stack', id: app.id, orgId: who.orgId, labels: app.labels ?? {} }
                : { type: 'service', id: `${app.id}/(any part)`, orgId: who.orgId, labels: app.labels ?? {} },
              principal,
              grants,
            ),
          }));
    const allowedOn: string[] = [];
    const deniedOn: string[] = [];
    let permitBy: InviteVerdict['permitBy'] = null;
    let blockedBy: InviteVerdict['blockedBy'] = null;
    let permitted = 0;
    for (const { name, resource } of resources) {
      const d = engine.evaluate({ principal, action: ability.action, resource });
      const ref = ruleRef(byId, d.policyId);
      if (d.decision === 'permit') {
        permitted++;
        if (name) allowedOn.push(name);
        permitBy ??= ref;
      } else {
        if (name) deniedOn.push(name);
        // A deny that names a rule is a forbid; default-deny names none.
        blockedBy ??= ref;
      }
    }
    const reach: InviteVerdict['reach'] = permitted === resources.length ? 'all' : permitted === 0 ? 'none' : 'some';
    return { key: ability.key, label: ability.label, action: ability.action, on: ability.on, reach, allowedOn, deniedOn, permitBy, blockedBy };
  });
}
