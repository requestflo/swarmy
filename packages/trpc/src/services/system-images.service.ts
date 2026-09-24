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
import { createHash } from 'node:crypto';
import { registryConfigs } from './apps.repo';
import { allOrgRows } from './backups.repo';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { RunOnceResult, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  RAILPACK_PLAN_IMAGE_KEYS,
  SYSTEM_IMAGES,
  SWARM_NODE_ID_LABEL,
  copySourceFor,
  mirrorLabelsAfter,
  mirroredRefFor,
  parseMirrorOutput,
  planMirror,
  railpackImageRewrites,
  renderMirrorScript,
  systemImage,
  systemImageForRef,
  type SystemImage,
} from '@swarmy/core/system-images';
import type { AgentHub, CommandName } from '../hub/types';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';
import { canonicalRegistryHost } from './registryPolicy.service';
import { REGISTRY_IMAGE, REGISTRY_MANAGED_LABEL, REGISTRY_SERVICE_NAME, decodeRegistryCreds } from './registry-auth';
import { effectiveImagesFor } from './platform-images';

// ── Pull-through cache (Docker Hub) ──────────────────────────────────────────

export const REGISTRY_CACHE_SERVICE_NAME = 'swarmy-registry-cache';
export const REGISTRY_CACHE_PORT = 5001;
export const REGISTRY_CACHE_LABEL = 'swarmy.registry.cache';
const DEFAULT_CACHE_UPSTREAM = 'https://registry-1.docker.io';

/** Live-service label naming the Docker Hub login the cache runs with (`<user>:<secret>`). */
export const REGISTRY_CACHE_AUTH_LABEL = 'swarmy.registry.cache.auth';
/** Content-addressed Docker secret holding the cache's Docker Hub password/token. */
export const REGISTRY_CACHE_SECRET_PREFIX = 'swarmy-registry-cache-hub-';
/** Where the shim exports the password from (`/run/secrets/<target>` → env). */
const CACHE_PASSWORD_ENV = 'REGISTRY_PROXY_PASSWORD';

/** The cache's Docker Hub login: username + the Docker secret with the password. */
export interface RegistryCacheHubAuth {
  username: string;
  secret: string;
}

/** Content-addressed secret name for a Hub login (same scheme as the htpasswd secret). */
export function registryCacheSecretName(username: string, password: string): string {
  const h = createHash('sha256').update(`${username}:${password}`).digest('hex').slice(0, 16);
  return `${REGISTRY_CACHE_SECRET_PREFIX}${h}`;
}

/** The auth label value a cache spec carries ('' = anonymous). */
export function registryCacheAuthSignature(auth: RegistryCacheHubAuth | null | undefined): string {
  return auth ? `${auth.username}:${auth.secret}` : '';
}

/**
 * The pull-through cache: a second `registry:2` in proxy mode (a proxy
 * registry is read-only, so it can't share the push registry). Unauthenticated
 * on purpose — dockerd's `registry-mirrors` sends no creds — so, like :5000,
 * port 5001 is kept loopback-only by the agent's registry firewall floor
 * (apps/agent/src/handlers/registry-firewall.ts, DOCKER-USER). Cached blobs expire
 * after `REGISTRY_PROXY_TTL`. `SWARMY_REGISTRY_CACHE_UPSTREAM` points it at
 * another upstream (an estate mirror) for air-gapped installs.
 *
 * `hubAuth` logs the cache in to Docker Hub (`REGISTRY_PROXY_USERNAME` /
 * `REGISTRY_PROXY_PASSWORD`), lifting the anonymous per-IP pull limit that
 * otherwise turns into a 500 from the cache on every docker.io deploy. The
 * password never enters the spec: it is a Docker secret the secret-env shim
 * exports as `REGISTRY_PROXY_PASSWORD` inside the task.
 */
export function registryCacheServiceSpec(
  upstream = process.env.SWARMY_REGISTRY_CACHE_UPSTREAM || DEFAULT_CACHE_UPSTREAM,
  hubAuth?: RegistryCacheHubAuth | null,
): ServiceSpec {
  return {
    name: REGISTRY_CACHE_SERVICE_NAME,
    image: REGISTRY_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: {
      [REGISTRY_MANAGED_LABEL]: 'true',
      'swarmy.system': 'true',
      [REGISTRY_CACHE_LABEL]: 'docker.io',
      [REGISTRY_CACHE_AUTH_LABEL]: registryCacheAuthSignature(hubAuth),
    },
    env: {
      REGISTRY_PROXY_REMOTEURL: upstream,
      REGISTRY_PROXY_TTL: '168h',
      REGISTRY_STORAGE_DELETE_ENABLED: 'true',
      ...(hubAuth ? { REGISTRY_PROXY_USERNAME: hubAuth.username } : {}),
    },
    ...(hubAuth
      ? {
          secrets: [{ source: hubAuth.secret, target: CACHE_PASSWORD_ENV, mode: 0o400 }],
          secretEnv: [CACHE_PASSWORD_ENV],
        }
      : {}),
    ports: [{ target: 5000, published: REGISTRY_CACHE_PORT, protocol: 'tcp', mode: 'ingress' }],
    mounts: [{ type: 'volume', source: 'swarmy-registry-cache-data', target: '/var/lib/registry' }],
  };
}

/** Does the live cache run with the wanted Hub login? (Anonymous ⇔ no/empty label.) */
export function registryCacheConverged(
  live: Pick<SwarmServiceInfo, 'labels'> | undefined,
  hubAuth: RegistryCacheHubAuth | null | undefined,
): boolean {
  return !!live && (live.labels[REGISTRY_CACHE_AUTH_LABEL] ?? '') === registryCacheAuthSignature(hubAuth);
}

/** The stored Hub login of an org's registry config, if complete. */
export function cacheHubAuthOf(row: { cacheUsername?: string | null; cacheSecret?: string | null } | null | undefined): RegistryCacheHubAuth | null {
  return row?.cacheUsername && row.cacheSecret ? { username: row.cacheUsername, secret: row.cacheSecret } : null;
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
  if (cmd === 'image.build' && p) {
    let out = p;
    if (!p.builderImage) {
      const to = map(systemImage('buildkit', images).ref);
      if (to) out = { ...out, builderImage: to };
    }
    // Zero-config builds: the Railpack frontend, the `prepare` image and the
    // plan's base images come from the cluster too (by digest) when mirrored.
    if (p.builder === 'railpack' || p.builder === 'auto') {
      const rp = (p.railpack ?? {}) as Record<string, unknown>;
      const frontend = rp.frontendImage ? null : map(systemImage('railpackFrontend', images).ref);
      const prepare = rp.prepareImage ? null : map(systemImage('railpackPrepare', images).ref);
      const rewrites: Record<string, string> = {};
      if (!rp.imageRewrites) {
        for (const k of RAILPACK_PLAN_IMAGE_KEYS) {
          const img = systemImage(k, images);
          const to = map(img.ref);
          if (to) rewrites[img.ref] = to;
        }
      }
      if (frontend || prepare || Object.keys(rewrites).length) {
        out = {
          ...out,
          railpack: {
            ...rp,
            ...(frontend ? { frontendImage: frontend } : {}),
            ...(prepare ? { prepareImage: prepare } : {}),
            // Unmirrored plan images keep the agent's digest-pinned default.
            ...(Object.keys(rewrites).length ? { imageRewrites: { ...railpackImageRewrites(undefined, images), ...rewrites } } : {}),
          },
        };
      }
    }
    return out === p ? payload : (out as P);
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

/** Deploy the cache when missing, or redeploy it when its Hub login drifted from the config. */
export async function ensureCache(
  deps: Pick<Deps, 'hub'>,
  orgId: string,
  nodeId: string,
  hubAuth: RegistryCacheHubAuth | null,
): Promise<'noop' | 'deployed'> {
  const live = deps.hub.liveInventory(orgId).services.find((s) => s.name === REGISTRY_CACHE_SERVICE_NAME);
  if (live && registryCacheConverged(live, hubAuth)) return 'noop';
  await deps.hub.dispatch(nodeId, 'service.deploy', { spec: registryCacheServiceSpec(undefined, hubAuth), pullPolicy: 'missing' });
  return 'deployed';
}

export async function mirrorSystemImagesForOrg(
  deps: Deps,
  orgId: string,
  ensureRegistry?: EnsureRegistry,
  /** What to mirror: default the running release's BOM (platform manifest digests filled in). */
  imagesIn?: readonly SystemImage[],
): Promise<MirrorTickResult> {
  const images = imagesIn ?? (await effectiveImagesFor(deps.db, orgId));
  const row = await registryConfigs(deps, orgId).findFirst();
  if (!row?.enabled) return { orgId, copied: [], failed: [], skipped: 'registry disabled' };
  const manager = deps.hub.managerNode(orgId);
  if (!manager) return { orgId, copied: [], failed: [], skipped: 'no manager online' };
  if (ensureRegistry) await ensureRegistry(deps, orgId).catch(() => undefined);
  await ensureCache(deps, orgId, manager, cacheHubAuthOf(row)).catch(() => undefined);

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
  const orgs = await allOrgRows(deps, registryConfigs, { where: { enabled: true } });
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

// ── Docker Hub login for the pull-through cache ──────────────────────────────

export interface RegistryCacheView {
  /** The Docker Hub username the cache logs in with; null = anonymous (rate-limited). */
  username: string | null;
  /** The live cache runs with the configured login (false while it rolls). */
  applied: boolean;
  /** The cache service is deployed. */
  deployed: boolean;
}

export function registryCacheView(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>, row: Parameters<typeof cacheHubAuthOf>[0]): RegistryCacheView {
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === REGISTRY_CACHE_SERVICE_NAME);
  const auth = cacheHubAuthOf(row);
  return { username: auth?.username ?? null, applied: registryCacheConverged(live, auth), deployed: !!live };
}

export async function getRegistryCache(ctx: OrgContext): Promise<RegistryCacheView> {
  const row = await registryConfigs(ctx, ctx.activeOrgId).findFirst();
  return registryCacheView(ctx, row);
}

/**
 * Set (or clear, with `null`) the Docker Hub login the pull-through cache
 * uses. The password/token becomes a content-addressed Docker secret; only
 * the username and the secret NAME are stored. The cache is redeployed with
 * the login straight away, and older login secrets are removed.
 */
export async function setRegistryCacheCredentials(
  ctx: OrgContext,
  input: { username: string; password: string } | null,
): Promise<RegistryCacheView> {
  const node = await resolveManagerNode(ctx);
  let auth: RegistryCacheHubAuth | null = null;
  if (input) {
    const username = input.username.trim();
    if (!username || !input.password) throw commandRejected('Docker Hub username and password/token are both required.');
    auth = { username, secret: registryCacheSecretName(username, input.password) };
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', {
        name: auth.secret,
        dataB64: Buffer.from(input.password, 'utf8').toString('base64'),
        labels: { 'swarmy.managed': 'true', [REGISTRY_CACHE_AUTH_LABEL]: 'true' },
      });
    } catch (e) {
      // Content-addressed: an existing secret of this name holds this login.
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw mapDispatchError(e);
    }
  }
  await registryConfigs(ctx, ctx.activeOrgId).update({
    where: { orgId: ctx.activeOrgId },
    data: { cacheUsername: auth?.username ?? null, cacheSecret: auth?.secret ?? null },
  });
  try {
    await ensureCache(ctx, ctx.activeOrgId, node.id, auth);
  } catch (e) {
    throw mapDispatchError(e);
  }
  try {
    const listed = await ctx.hub.dispatch<{ secrets?: Array<{ name: string }> }>(node.id, 'secret.list', {});
    for (const s of listed?.secrets ?? []) {
      if (s.name.startsWith(REGISTRY_CACHE_SECRET_PREFIX) && s.name !== auth?.secret) {
        await ctx.hub.dispatch(node.id, 'secret.remove', { name: s.name }).catch(() => undefined);
      }
    }
  } catch {
    // A stale secret is harmless: the cache no longer mounts it.
  }
  await writeAudit(ctx, {
    action: auth ? 'cicd.registryCache.login.set' : 'cicd.registryCache.login.clear',
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
    metadata: { username: auth?.username ?? null },
  });
  return getRegistryCache(ctx);
}
