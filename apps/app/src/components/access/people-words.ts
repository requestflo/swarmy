const DAY = 86_400_000;

/**
 * "Last seen" from the newest session's updatedAt. Sessions refresh on use
 * about once a day, so it reads in days, never minutes.
 */
export function lastSeenWords(at: string | null | undefined, now = Date.now()): string {
  if (!at) return 'not signed in';
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  if (days < 1) return 'seen today';
  if (days === 1) return 'seen yesterday';
  if (days < 60) return `seen ${days} days ago`;
  return `seen ${Math.floor(days / 30)} months ago`;
}

interface GrantLike {
  principalType: string;
  principalId: string;
  resourceType: string;
  resourceId: string;
  relation: string;
}

/** "every app" for owners/admins; a member's app grants ("operator on storefront"), else null. */
export function memberScopeWords(
  member: { id: string; role: string },
  grants: GrantLike[],
  stackName: (id: string) => string,
): string | null {
  if (member.role === 'owner' || member.role === 'admin') return 'every app';
  const mine = grants.filter((g) => g.principalType === 'member' && g.principalId === member.id && g.resourceType === 'stack');
  if (!mine.length) return null;
  const byRelation = new Map<string, string[]>();
  for (const g of mine) byRelation.set(g.relation, [...(byRelation.get(g.relation) ?? []), stackName(g.resourceId)]);
  return [...byRelation].map(([rel, apps]) => `${rel} on ${apps.join(', ')}`).join(' · ');
}
