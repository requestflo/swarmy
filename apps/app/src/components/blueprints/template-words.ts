import type { BlueprintMetaView } from '@swarmy/core';

const MANAGED: Record<string, string> = {
  postgres: 'its own database',
  cache: 'a fast cache',
  bucket: 'file storage',
  search: 'search',
};

/** "What you get", in plain words, from the card's resource chips. */
export function youGet(meta: BlueprintMetaView): { what: string; detail: string }[] {
  const out: { what: string; detail: string }[] = [];
  const managed = (meta.managed ?? []).map((m) => MANAGED[m]).filter(Boolean);
  const services = meta.services?.length ?? 0;
  out.push({
    what: 'The app',
    detail: managed.length ? `with ${managed.join(', ')}, all wired together` : services > 1 ? `${services} parts, wired together` : 'ready to run',
  });
  if (meta.resources.includes('Secret') || meta.managed?.includes('postgres')) {
    out.push({ what: 'Passwords', detail: 'made for you; you never paste one' });
  }
  if (meta.resources.includes('Volume')) out.push({ what: 'Its files', detail: 'kept on disk across restarts and updates' });
  if (meta.resources.includes('Private')) {
    out.push({ what: 'Private', detail: 'only your other apps can reach it' });
  } else if (meta.supportsDomain) {
    out.push({ what: 'HTTPS', detail: 'at a web address, or your own domain any time' });
  }
  return out;
}

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
