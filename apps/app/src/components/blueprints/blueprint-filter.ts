import { BLUEPRINT_CATEGORIES, type BlueprintCategory, type BlueprintMetaView } from '@swarmy/core';

export type CategoryFilter = BlueprintCategory | 'all';

/** Case-insensitive match on name, tagline, id, category label and resource chips. */
export function matchesQuery(meta: BlueprintMetaView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const label = BLUEPRINT_CATEGORIES.find((c) => c.id === meta.category)?.label ?? '';
  const hay = [meta.name, meta.tagline, meta.id, label, ...meta.resources, ...(meta.managed ?? [])]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export function filterBlueprints(
  cards: BlueprintMetaView[],
  query: string,
  category: CategoryFilter,
): BlueprintMetaView[] {
  return cards.filter(
    (m) => (category === 'all' || m.category === category) && matchesQuery(m, query),
  );
}

/** Categories that have at least one card matching the query, with counts, in display order. */
export function categoryCounts(
  cards: BlueprintMetaView[],
  query: string,
): Array<{ id: BlueprintCategory; label: string; count: number }> {
  const matching = cards.filter((m) => matchesQuery(m, query));
  return BLUEPRINT_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    count: matching.filter((m) => m.category === c.id).length,
  })).filter((c) => c.count > 0);
}
