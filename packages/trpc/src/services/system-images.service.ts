/**
 * System-image mirror + Docker Hub pull-through cache (self-reliance B3/B4).
 *
 * The BOM and all decisions live in `@swarmy/core/system-images` (pure). This
 * module is the controller glue:
 *
 *  - {@link rewriteSystemImages}: the hub dispatch decorator step that turns a
 *    pull of an exact upstream system ref into the mirrored
 *    `<registry>/swarmy-system/…@sha256:…` ref (so swarmy's services deploy from
 *    the cluster, by digest). `container.runOnce` also carries the original ref
 *    as `fallbackImage`, and a build's BuildKit image falls back to upstream on
 *    the agent, so a registry outage degrades to "pull upstream" instead of
 *    failing.
 *  - {@link mirrorSystemImagesAllOrgs}: the `system-image-mirror` worker tick.
 *    For every org whose built-in registry is enabled it makes sure the
 *    registry is deployed, deploys the Docker Hub pull-through cache, copies the
 *    BOM into the registry with a `regctl` one-shot (host network → the routing
 *    mesh's `localhost:5000`, like trivy/cosign; the controller itself never
 *    talks to a registry), and stamps the result as registry service labels.
 *
 * Node dockerd uses the cache through `registry-mirrors` in daemon.json, which
 * the installers merge (`apps/api/src/install/docker-registry-mirror.ts`).
 */
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { RunOnceResult, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  SYSTEM_IMAGES,
  SWARM_NODE_ID_LABEL,
  copySourceFor,
  mirrorLabelsAfter,
  mirroredRefFor,
  parseMirrorOutput,
  planMirror,
  renderMirrorScript,
  systemImage,
  systemImageForRef,
  type SystemImage,
} from '@swarmy/core/system-images';
import type { AgentHub, CommandName } from '../hub/types';
import { canonicalRegistryHost } from './registryPolicy.service';
import { REGISTRY_IMAGE, REGISTRY_MANAGED_LABEL, REGISTRY_SERVICE_NAME, decodeRegistryCreds } from './registry-auth';
import { effectiveImagesFor } from './platform-images';

// ── Pull-through cache (Docker Hub) ──────────────────────────────────────────

export const REGISTRY_CACHE_SERVICE_NAME = 'swarmy-registry-cache';
export const REGISTRY_CACHE_PORT = 5001;
/** What node dockerd's `registry-mirrors` points at (routing mesh; loopback is insecure-trusted). */
export const REGISTRY_CACHE_MIRROR_URL = `http://localhost:${REGISTRY_CACHE_PORT}`;
export const REGISTRY_CACHE_LABEL = 'swarmy.registry.cache';
const DEFAULT_CACHE_UPSTREAM = 'https://registry-1.docker.io';

/**
 * The pull-through cache: a second `registry:2` in proxy mode (a proxy
 * registry is read-only, so it can't share the push registry). Unauthenticated
 * on purpose — dockerd's `registry-mirrors` sends no creds — so, like :5000,
 * port 5001 must be firewalled from outside the swarm. Cached blobs expire
 * after `REGISTRY_PROXY_TTL`. `SWARMY_REGISTRY_CACHE_UPSTREAM` points it at
 * another upstream (an estate mirror) for air-gapped installs.
 */
export function registryCacheServiceSpec(upstream = process.env.SWARMY_REGISTRY_CACHE_UPSTREAM || DEFAULT_CACHE_UPSTREAM): ServiceSpec {
  return {
    name: REGISTRY_CACHE_SERVICE_NAME,
    image: REGISTRY_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: { [REGISTRY_MANAGED_LABEL]: 'true', 'swarmy.system': 'true', [REGISTRY_CACHE_LABEL]: 'docker.io' },
    env: {
      REGISTRY_PROXY_REMOTEURL: upstream,
      REGISTRY_PROXY_TTL: '168h',
      REGISTRY_STORAGE_DELETE_ENABLED: 'true',
    },
    ports: [{ target: 5000, published: REGISTRY_CACHE_PORT, protocol: 'tcp', mode: 'ingress' }],
    mounts: [{ type: 'volume', source: 'swarmy-registry-cache-data', target: '/var/lib/registry' }],
  };
}

// ── Live mirror state (Docker truth) ─────────────────────────────────────────

export interface MirrorState {
  labels: Record<string, string>;
  /** Swarm node id the registry task is running on (null = not running / unknown). */
  registryNodeId: string | null;
  registry: SwarmServiceInfo | undefined;
}

/** Pure over a live inventory snapshot. */
export function mirrorStateFrom(inv: {
  services: SwarmServiceInfo[];
  containers: Array<{ state: string; labels: Record<string, string>; serviceId?: string }>;
}): MirrorState {
  const registry = inv.services.find((s) => s.name === REGISTRY_SERVICE_NAME);
  const task = registry
    ? inv.containers.find(
        (c) =>
          c.state === 'running' &&
          (c.serviceId === registry.id || c.labels['com.docker.swarm.service.name'] === REGISTRY_SERVICE_NAME),
      )
    : undefined;
  return {
    labels: registry?.labels ?? {},
    registryNodeId: task?.labels[SWARM_NODE_ID_LABEL] ?? null,
    registry,
  };
}

// ── Dispatch rewrite (pure) ──────────────────────────────────────────────────

/**
 * Rewrite the image a dispatch pulls to its mirrored digest ref when it is an
 * exact upstream system ref that is mirrored + trusted. Same reference back
 * when nothing changes. Commands: `service.deploy` (spec.image),
 * `container.runOnce` (image + `fallbackImage`), `image.build` (BuildKit
 * `builderImage` when unset). `image.pull` is deliberately NOT rewritten: it
 * pre-stages images for later `pull: false` runOnces, which pick whichever of
 * the mirrored / upstream ref is on the node (agent `presentOrFallback`), and
 * the pull command has no upstream fallback of its own.
 */
export function rewriteSystemImages<P>(
  cmd: CommandName,
  payload: P,
  registryHost: string,
  state: MirrorState,
  /** The BOM with the running release's digests (platform manifest); default the compiled BOM. */
  images: readonly SystemImage[] = SYSTEM_IMAGES,
): P {
  if (!state.registryNodeId) return payload;
  const map = (ref: unknown) =>
    typeof ref === 'string' ? mirroredRefFor(ref, registryHost, state.labels, state.registryNodeId, images) : null;
  const p = payload as Record<string, unknown> & { spec?: Record<string, unknown> };
  if (cmd === 'service.deploy' && p?.spec) {
    const to = map(p.spec.image);
    return to ? ({ ...p, spec: { ...p.spec, image: to } } as P) : payload;
  }
  if (cmd === 'container.runOnce') {
    const to = map(p?.image);
    return to ? ({ ...p, image: to, fallbackImage: p.image } as P) : payload;
  }
  if (cmd === 'image.build' && p && !p.builderImage) {
    const to = map(systemImage('buildkit', images).ref);
    return to ? ({ ...p, builderImage: to } as P) : payload;
  }
  return payload;
}

/**
 * Deploy by digest even without a mirror (plans/epic-platform-upgrades.md §1:
 * no floating tags in running services): a `service.deploy` of an exact
 * system ref whose release digest is known becomes `<upstream repo>@<digest>`.
 * Runs AFTER {@link rewriteSystemImages} (a mirrored ref is no longer an
 * upstream ref, so it is left alone). One-shots keep their tag: they stage
 * images by tag for `pull: false` runs. Pure.
 */
export function pinSystemImages<P>(cmd: CommandName, payload: P, images: readonly SystemImage[] = SYSTEM_IMAGES): P {
  const p = payload as Record<string, unknown> & { spec?: Record<string, unknown> };
  if (cmd !== 'service.deploy' || !p?.spec || typeof p.spec.image !== 'string') return payload;
  const img = systemImageForRef(p.spec.image, images);
  if (!img?.digest || img.noRewrite) return payload;
  return { ...p, spec: { ...p.spec, image: copySourceFor(img) } } as P;
}

// ── Mirror tick ──────────────────────────────────────────────────────────────

export interface MirrorTickResult {
  orgId: string;
  copied: string[];
  failed: string[];
  skipped?: string;
}

type Deps = { db: DB; hub: AgentHub; auth: Auth };

/** Seam so the worker can make sure an enabled registry is actually deployed (cicd.service). */
export type EnsureRegistry = (deps: Deps, orgId: string) => Promise<unknown>;

async function ensureCache(deps: Deps, orgId: string, nodeId: string): Promise<void> {
  const live = deps.hub.liveInventory(orgId).services.some((s) => s.name === REGISTRY_CACHE_SERVICE_NAME);
  if (live) return;
  await deps.hub.dispatch(nodeId, 'service.deploy', { spec: registryCacheServiceSpec(), pullPolicy: 'missing' });
}

export async function mirrorSystemImagesForOrg(
  deps: Deps,
  orgId: string,
  ensureRegistry?: EnsureRegistry,
  /** What to mirror: default the running release's BOM (platform manifest digests filled in). */
  imagesIn?: readonly SystemImage[],
): Promise<MirrorTickResult> {
  const images = imagesIn ?? (await effectiveImagesFor(deps.db, orgId));
  const row = await deps.db.registryConfig.findUnique({
    where: { orgId },
    select: { enabled: true, host: true, credentialsEnc: true },
  });
  if (!row?.enabled) return { orgId, copied: [], failed: [], skipped: 'registry disabled' };
  const manager = deps.hub.managerNode(orgId);
  if (!manager) return { orgId, copied: [], failed: [], skipped: 'no manager online' };
  if (ensureRegistry) await ensureRegistry(deps, orgId).catch(() => undefined);
  await ensureCache(deps, orgId, manager).catch(() => undefined);

  const state = mirrorStateFrom(deps.hub.liveInventory(orgId));
  if (!state.registry || !state.registryNodeId) return { orgId, copied: [], failed: [], skipped: 'registry not running yet' };
  const host = canonicalRegistryHost(row.host);
  const todo = planMirror(state.labels, state.registryNodeId, images);
  if (!todo.length) return { orgId, copied: [], failed: [] };

  const creds = decodeRegistryCreds(row.credentialsEnc);
  const res = await deps.hub.dispatch<RunOnceResult>(
    manager,
    'container.runOnce',
    {
      image: systemImage('regctl').ref,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [renderMirrorScript(todo, host)],
      env: creds ? { SWARMY_REG_USER: creds.username, SWARMY_REG_PASS: creds.password } : {},
      networks: ['host'],
      timeoutMs: 45 * 60_000,
    },
    { timeoutMs: 46 * 60_000 },
  );
  const out = parseMirrorOutput(res.output);
  const { add, removeKeys } = mirrorLabelsAfter(state.labels, state.registryNodeId, out.ok, images);
  await deps.hub.dispatch(manager, 'service.updateLabels', { service: REGISTRY_SERVICE_NAME, add, removeKeys });
  return { orgId, copied: [...out.ok.keys()], failed: out.failed };
}

export async function mirrorSystemImagesAllOrgs(deps: Deps, ensureRegistry?: EnsureRegistry): Promise<MirrorTickResult[]> {
  const orgs = await deps.db.registryConfig.findMany({ where: { enabled: true }, select: { orgId: true } });
  const out: MirrorTickResult[] = [];
  for (const { orgId } of orgs) {
    out.push(
      await mirrorSystemImagesForOrg(deps, orgId, ensureRegistry).catch((e) => ({
        orgId,
        copied: [],
        failed: [],
        skipped: e instanceof Error ? e.message : String(e),
      })),
    );
  }
  return out;
}
