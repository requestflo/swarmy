/**
 * Drift: running system services that are not on the release the cluster
 * runs (plans/epic-platform-upgrades.md §1, "live service images vs manifest
 * = drift"). Pure — the IO is `platform-drift.service.ts`, the words are the
 * dashboard's (`components/platform/drift-words.ts`).
 *
 * A live service is matched to a manifest component by repository (mirrored
 * copies included, `repoOf`). It is on the release when its digest equals the
 * digest of ANY component in that repository — a Garage store still on v1 is
 * a pending engine migration, not drift. Otherwise:
 *
 *   digest    pinned, but to another build than the release names;
 *   floating  no digest at all (a tag such as `:latest`): a restart can pull anything;
 *   tag       the release names no exact build (a development BOM), and the
 *             running tag differs from the one it names — nothing to pin to.
 *
 * Only the services the system step rolls (DNS, edges, observability) can be
 * re-pinned from Settings › Platform, with the same health-gated update the
 * upgrade uses. The controller (it replaces itself) and object storage (one
 * member at a time, inside an upgrade) are explained instead.
 */
import { SYSTEM_ORDER, digestOf, repoOf, type ManifestComponentLite } from './platform-upgrade.plan';

export type DriftOwner = 'system' | 'controller' | 'engine';
export type DriftKind = 'digest' | 'floating' | 'tag';
export type DriftAction = 'repin' | 'explain';

/** The manifest components whose services a platform run owns, and which part of the run moves them. */
export const DRIFT_KEYS: Readonly<Record<string, DriftOwner>> = {
  ...Object.fromEntries(Object.keys(SYSTEM_ORDER).map((k) => [k, 'system' as const])),
  controller: 'controller',
  garage: 'engine',
  garageV1: 'engine',
};

const OWNER_ORDER: Record<DriftOwner, number> = { controller: 0, system: 1, engine: 2 };
const CONTROLLER_SERVICE = 'swarmy_controller';

export interface DriftRow {
  service: string;
  /** The manifest component it should run. */
  key: string;
  owner: DriftOwner;
  /** The live service image, exactly as Swarm reports it. */
  running: string;
  /** `<image>@<digest>` the release names; null when it names no exact build. */
  expected: string | null;
  kind: DriftKind;
  action: DriftAction;
}

export interface DriftService {
  name: string;
  image: string;
  labels?: Record<string, string>;
}

function isSystemService(s: DriftService): boolean {
  return (
    s.name === CONTROLLER_SERVICE ||
    s.name.startsWith('swarmy-') ||
    s.labels?.['swarmy.system'] === 'true' ||
    s.labels?.['com.docker.stack.namespace'] === 'swarmy-system'
  );
}

/** The tag of an image ref (`caddy:2-alpine@sha256:…` → `2-alpine`), null when it has none. Pure. */
export function tagOf(image: string): string | null {
  const bare = image.split('@')[0] ?? image;
  const slash = bare.lastIndexOf('/');
  const colon = bare.lastIndexOf(':');
  return colon > slash ? bare.slice(colon + 1) : null;
}

/** Every live system service that is off the release, controller first. Pure. */
export function planDrift(services: readonly DriftService[], components: Record<string, ManifestComponentLite>): DriftRow[] {
  const byRepo = new Map<string, string[]>();
  for (const [key, c] of Object.entries(components)) {
    if (!DRIFT_KEYS[key]) continue;
    for (const repo of new Set([repoOf(c.ref), repoOf(c.image)])) byRepo.set(repo, [...(byRepo.get(repo) ?? []), key]);
  }
  const rows: DriftRow[] = [];
  for (const s of services) {
    if (!isSystemService(s)) continue;
    const keys = byRepo.get(repoOf(s.image));
    if (!keys?.length) continue;
    const live = digestOf(s.image);
    if (live && keys.some((k) => components[k]!.digest === live)) continue;
    const tag = tagOf(s.image) ?? 'latest';
    const key = keys.find((k) => (tagOf(components[k]!.ref) ?? 'latest') === tag) ?? keys[0]!;
    const c = components[key]!;
    const owner = DRIFT_KEYS[key]!;
    if (!c.digest) {
      // No exact build named: only a different tag is drift, and there is nothing to pin to.
      if (tag === (tagOf(c.ref) ?? 'latest')) continue;
      rows.push({ service: s.name, key, owner, running: s.image, expected: null, kind: 'tag', action: 'explain' });
      continue;
    }
    rows.push({
      service: s.name,
      key,
      owner,
      running: s.image,
      expected: `${c.image}@${c.digest}`,
      kind: live ? 'digest' : 'floating',
      action: owner === 'system' ? 'repin' : 'explain',
    });
  }
  return rows.sort((a, b) => OWNER_ORDER[a.owner] - OWNER_ORDER[b.owner] || a.service.localeCompare(b.service));
}
