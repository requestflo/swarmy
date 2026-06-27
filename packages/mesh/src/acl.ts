/**
 * Driver-agnostic ACL / access model for direct-stack-connect (epic #6, Phase 2).
 *
 * An operator/CI peer is granted a point-to-point route to one service over the
 * mesh. We express that intent once as a {@link MeshAccessIntent} and let each
 * driver render it into its own enforcement primitive:
 *   - Headscale → a HuJSON ACL policy file ({@link buildHeadscaleAcl})
 *   - NetBird   → groups + a policy (pushed via the Admin API, see DriverControlPlane)
 *   - wireguard → per-peer AllowedIPs / iptables (node-local, via grantDirectRoute)
 *
 * Everything here is PURE and unit-tested with goldens — no IO, no provider SDK.
 */

/** A single direct-connect grant: principal → target over the mesh. */
export interface MeshGrant {
  /** Stable id (DB `MeshRoute.id`) — used to name groups/tags deterministically. */
  id: string;
  /** Mesh tag/group the principal peer carries (e.g. `tag:dc-<routeId>`). */
  principalTag: string;
  /** Mesh tag/group the target service node(s) carry. */
  targetTag: string;
  /** Destination ports on the target (empty ⇒ all ports). */
  ports: number[];
  /** Optional protocol restriction. */
  proto?: 'tcp' | 'udp';
}

export interface MeshAccessIntent {
  /** Org identifier — namespaces tags so two orgs never collide. */
  orgId: string;
  grants: MeshGrant[];
}

/** Deterministic tag for a direct-connect route's ephemeral principal peer. */
export function principalTagForRoute(routeId: string): string {
  return `tag:dc-${routeId}`;
}

/** Deterministic tag for a direct-connect target (service or stack). */
export function targetTagForRoute(routeId: string): string {
  return `tag:svc-${routeId}`;
}

/**
 * Render a Headscale ACL (HuJSON-compatible JSON). Headscale consumes a single
 * org-wide policy document, so we fold every grant into one `acls` array. Output
 * is stable (sorted by grant id) so goldens are diff-friendly.
 */
export function buildHeadscaleAcl(intent: MeshAccessIntent): string {
  const grants = [...intent.grants].sort((a, b) => (a.id < b.id ? -1 : 1));
  const tagOwners: Record<string, string[]> = {};
  const acls = grants.map((g) => {
    tagOwners[g.principalTag] = ['swarmy'];
    tagOwners[g.targetTag] = ['swarmy'];
    const portSuffix = g.ports.length ? g.ports.join(',') : '*';
    return {
      action: 'accept' as const,
      proto: g.proto,
      src: [g.principalTag],
      dst: [`${g.targetTag}:${portSuffix}`],
    };
  });
  const doc = {
    // Headscale uses HuJSON; plain JSON is a valid subset.
    tagOwners,
    acls: acls.map((a) => (a.proto ? a : { action: a.action, src: a.src, dst: a.dst })),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Render the NetBird policy/group plan for an access intent. The controller
 * pushes these via the Admin API (`/api/groups`, `/api/policies`). Pure: returns
 * the desired group set + policy rules, the service diffs against live state.
 */
export interface NetbirdPolicyPlan {
  groups: { name: string }[];
  policies: {
    name: string;
    enabled: boolean;
    sourceGroup: string;
    destinationGroup: string;
    ports: string[];
    protocol: 'tcp' | 'udp' | 'all';
  }[];
}

export function buildNetbirdPolicyPlan(intent: MeshAccessIntent): NetbirdPolicyPlan {
  const grants = [...intent.grants].sort((a, b) => (a.id < b.id ? -1 : 1));
  const groupNames = new Set<string>();
  const policies = grants.map((g) => {
    groupNames.add(g.principalTag);
    groupNames.add(g.targetTag);
    return {
      name: `dc-${g.id}`,
      enabled: true,
      sourceGroup: g.principalTag,
      destinationGroup: g.targetTag,
      ports: g.ports.map((p) => String(p)),
      protocol: (g.proto ?? 'all') as 'tcp' | 'udp' | 'all',
    };
  });
  return {
    groups: [...groupNames].sort().map((name) => ({ name })),
    policies,
  };
}
