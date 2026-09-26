import { BLUEPRINT_CATEGORIES, type BlueprintMetaView } from '@swarmy/core';

/** "~420 MB" / "~1.3 GB" from the template's memory estimate. */
export function memoryLabel(meta: BlueprintMetaView): string | null {
  if (!meta.minMemoryMb) return null;
  return meta.minMemoryMb >= 1024 ? `~${(meta.minMemoryMb / 1024).toFixed(1)} GB` : `~${meta.minMemoryMb} MB`;
}

/** A valid default app name from the template id (lowercase, dashes, ≤30). */
export function defaultAppName(meta: BlueprintMetaView): string {
  return meta.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 30).replace(/-+$/, '') || 'app';
}

/** True for catalogue templates that get an automatic web address when no domain is given. */
export function getsAutoAddress(meta: BlueprintMetaView): boolean {
  return meta.source !== undefined && meta.source !== 'builtin' && meta.supportsDomain;
}

/** "2 services" from the catalogue's service list (null for built-ins that don't say). */
export function servicesLabel(meta: BlueprintMetaView): string | null {
  const n = meta.services?.length;
  return n ? `${n} service${n === 1 ? '' : 's'}` : null;
}

/** The category's chip label ("CMS & blogs"). */
export function categoryLabel(meta: BlueprintMetaView): string {
  return BLUEPRINT_CATEGORIES.find((c) => c.id === meta.category)?.label ?? meta.category;
}

/** Managed data, as the short chip words the cards use. */
export const MANAGED_CHIP: Record<string, string> = {
  postgres: 'Postgres',
  cache: 'cache',
  bucket: 'bucket',
  search: 'search',
};
