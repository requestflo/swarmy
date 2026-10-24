import { parsePolicyDoc, type PolicyDoc } from '@swarmy/abac/model';

export type RoleKey = 'owner' | 'admin' | 'member';

interface RuleLike {
  name: string;
  effect: 'permit' | 'forbid';
  source: string;
  priority: number;
  enabled: boolean;
}

export interface RolesGlance {
  /** Per role, the titles of the org's enabled rules that apply to everyone in it. */
  roles: Array<{ role: RoleKey; lines: string[] }>;
  /** Rules that follow an app grant (what an app-scoped invite adds). */
  grants: string[];
}

const ROLES: RoleKey[] = ['owner', 'admin', 'member'];

/** A rule that narrows WHO within a role (groups, named people, attributes) isn't the role's own. */
function narrowsWho(doc: PolicyDoc): boolean {
  return Boolean(
    (doc.groups?.length && !doc.groups.includes('*')) ||
      doc.members?.length ||
      (doc.attributes && Object.keys(doc.attributes).length) ||
      doc.ownerOnly,
  );
}

/**
 * "Roles at a glance" from the org's real rules: the default rules and any
 * custom ones an admin wrote, highest priority first. Owners also keep the one
 * rule that lives in code rather than policy: only an owner invites an owner.
 */
export function rolesAtAGlance(rules: RuleLike[]): RolesGlance {
  const out: RolesGlance = { roles: ROLES.map((role) => ({ role, lines: [] })), grants: [] };
  for (const r of [...rules].filter((x) => x.enabled).sort((a, b) => b.priority - a.priority)) {
    let doc: PolicyDoc;
    try {
      doc = parsePolicyDoc(r.source);
    } catch {
      continue;
    }
    if (narrowsWho(doc)) continue;
    // A rule over relations needs a grant on the resource: it follows the grant, not the role.
    if (doc.relations?.length) {
      out.grants.push(r.name);
      continue;
    }
    const roles = doc.roles ?? [];
    for (const entry of out.roles) {
      if (!roles.length || roles.includes(entry.role) || roles.includes('*')) entry.lines.push(r.name);
    }
  }
  out.roles[0]!.lines.push('Only an owner can invite another owner');
  return out;
}
