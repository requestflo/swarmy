import type { InvService } from '@swarmy/core';

/**
 * Environment lanes (board Environments): each environment's live services
 * with the image each runs, compared with production's. PURE — unit-tested.
 */
export interface LaneService {
  name: string;
  copies: number;
  image: string;
  /** "@d4e5f6a" for a digest, ":2.4.0" for a tag. */
  ref: string;
  /** Production runs something else under this name (or nothing). */
  differs: boolean;
}

/** `ghcr.io/x/web@sha256:d4e5f6a7…` → `@d4e5f6a`; `ghcr.io/x/api:2.4.0` → `:2.4.0`; bare → `:latest`. */
export function imageRef(image: string): string {
  const at = image.indexOf('@sha256:');
  if (at >= 0) return `@${image.slice(at + 8, at + 15)}`;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(colon) : ':latest';
}

const short = (stack: string, name: string): string => (name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name);

/** One lane's services, sorted by name, each marked when production runs a different image. */
export function laneServices(stack: string, services: readonly InvService[], prod: ReadonlyMap<string, string> | null): LaneService[] {
  return services
    .filter((s) => s.stack === stack && !s.regionParent)
    .map((s) => {
      const name = short(stack, s.name);
      return { name, copies: s.replicas.desired, image: s.image, ref: imageRef(s.image), differs: prod ? prod.get(name) !== s.image : false };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** name → image for a stack (what production runs, for comparison). */
export function imagesOf(stack: string, services: readonly InvService[]): Map<string, string> {
  return new Map(services.filter((s) => s.stack === stack && !s.regionParent).map((s) => [short(stack, s.name), s.image]));
}

export interface ImageChange {
  name: string;
  from: string | null;
  to: string;
}

/** What a promote sends: each service whose source digest differs from what production runs now. */
export function promoteChanges(images: Readonly<Record<string, string>>, prod: ReadonlyMap<string, string>): { changes: ImageChange[]; same: string[] } {
  const changes: ImageChange[] = [];
  const same: string[] = [];
  for (const [name, to] of Object.entries(images).sort(([a], [b]) => a.localeCompare(b))) {
    const from = prod.get(name) ?? null;
    if (from === to) same.push(name);
    else changes.push({ name, from, to });
  }
  return { changes, same };
}
