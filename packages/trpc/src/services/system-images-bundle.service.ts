/**
 * Seed the built-in registry from an offline bundle left on node #1 by
 * `install-swarmy.sh --bundle` (a fresh air-gapped install; the pure scripts
 * are `@swarmy/core/system-images-bundle`).
 *
 * The installer unpacks the bundle into a named volume and deploys the
 * controller with `SWARMY_BUNDLE_VOLUME=<name>`. Once the built-in registry
 * runs, this does what the bundle upload does (`platform-bundle.load.ts`), on
 * the node instead of through the browser:
 *
 *   1. read platform.json + .sig from the volume (regctl one-shot) and verify
 *      it against this controller's release key — nothing is copied for a
 *      release that fails;
 *   2. copy each image BY ITS SIGNED DIGEST from the bundle's OCI layout to
 *      the mirror path (host network → `localhost:5000`, the node's loopback
 *      forwarder, like the mirror copier — the controller itself can't reach
 *      the registry, M16);
 *   3. stamp the `swarmy.mirror.*` labels (`mirrorLabelsAfter`: a copy whose
 *      digest isn't the signed one is never trusted) + `swarmy.mirror.bundle`;
 *   4. store the release (`importRelease`, adopt off), audit, and remove the
 *      volume (gigabytes) once every image landed.
 *
 * The worker ticks it every minute until the bundle label is set.
 */
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { RunOnceResult } from '@swarmy/core/protocol';
import { mirrorLabelsAfter, parseMirrorOutput, systemImage } from '@swarmy/core/system-images';
import {
  BUNDLE_MOUNT,
  MIRROR_BUNDLE_LABEL,
  parseBundleRead,
  parseBundleSkipped,
  renderBundleCopyScript,
  renderBundleReadScript,
} from '@swarmy/core/system-images-bundle';
import type { AgentHub } from '../hub/types';
import { registryConfigs } from './apps.repo';
import { writeAudit } from './audit.service';
import { allOrgRows } from './backups.repo';
import { systemContext } from './cicd.service';
import { bundleImages } from './platform-bundle.load';
import { importRelease, verifyRelease } from './platform-release.service';
import { REGISTRY_SERVICE_NAME, decodeRegistryCreds } from './registry-auth';
import { canonicalRegistryHost } from './registryPolicy.service';
import { mirrorStateFrom } from './system-images.service';

type Deps = { db: DB; hub: AgentHub; auth: Auth };

export interface BundleSeedResult {
  orgId: string;
  state: 'skipped' | 'none' | 'unverified' | 'seeded' | 'partial';
  detail?: string;
  version?: string;
  copied?: string[];
  failed?: string[];
}

/** The volume the installer named, or null (no bundle install). */
export function bundleVolume(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.SWARMY_BUNDLE_VOLUME?.trim();
  return v && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) ? v : null;
}

/** The installer's node (it holds the volume): the manager with its hostname, else any manager. */
function bundleNode(hub: AgentHub, orgId: string): string | undefined {
  const host = (process.env.SWARMY_BUNDLE_HOSTNAME || process.env.SWARMY_NODE_HOSTNAME)?.trim();
  const byHost = host ? hub.managerNodes(orgId).find((id) => hub.nodeInfoFor(id)?.hostname === host) : undefined;
  return byHost ?? hub.managerNode(orgId);
}

export async function seedRegistryFromBundle(deps: Deps, orgId: string, volume: string): Promise<BundleSeedResult> {
  const skip = (detail: string): BundleSeedResult => ({ orgId, state: 'skipped', detail });
  const row = await registryConfigs(deps, orgId).findFirst();
  if (!row?.enabled) return skip('registry disabled');
  const state = mirrorStateFrom(deps.hub.liveInventory(orgId));
  if (!state.registry || !state.registryNodeId) return skip('registry not running yet');
  if (state.labels[MIRROR_BUNDLE_LABEL]) return skip(`already seeded (${state.labels[MIRROR_BUNDLE_LABEL]})`);
  const node = bundleNode(deps.hub, orgId);
  if (!node) return skip('no manager online');
  const oneShot = (cmd: string, extra: Record<string, unknown>, timeoutMs: number) =>
    deps.hub.dispatch<RunOnceResult>(
      node,
      'container.runOnce',
      { image: systemImage('regctl').ref, entrypoint: ['/bin/sh', '-c'], cmd: [cmd], binds: [`${volume}:${BUNDLE_MOUNT}:ro`], timeoutMs, ...extra },
      { timeoutMs: timeoutMs + 60_000 },
    );

  const read = parseBundleRead((await oneShot(renderBundleReadScript(), {}, 60_000)).output);
  if (!read) return { orgId, state: 'none', detail: `no bundle in volume ${volume} on this node` };
  const rel = verifyRelease(read.manifest, read.signature);
  if (!rel.manifest || !rel.verified) return { orgId, state: 'unverified', detail: rel.reason ?? 'signature check failed' };
  const m = rel.manifest;

  const images = bundleImages(m);
  const creds = decodeRegistryCreds(row.credentialsEnc);
  const copy = await oneShot(
    renderBundleCopyScript(images, canonicalRegistryHost(row.host)),
    { env: creds ? { SWARMY_REG_USER: creds.username, SWARMY_REG_PASS: creds.password } : {}, networks: ['host'] },
    45 * 60_000,
  );
  const out = parseMirrorOutput(copy.output);
  const skipped = new Set(parseBundleSkipped(copy.output));
  const failed = images.filter((i) => i.digest && !skipped.has(i.key) && !out.ok.has(i.key)).map((i) => i.key);
  const { add, removeKeys } = mirrorLabelsAfter(state.labels, state.registryNodeId, out.ok, images);
  if (!failed.length) add[MIRROR_BUNDLE_LABEL] = m.version;
  await deps.hub.dispatch(node, 'service.updateLabels', { service: REGISTRY_SERVICE_NAME, add, removeKeys });

  const ctx = systemContext(deps, orgId);
  const copied = [...out.ok.keys()];
  await writeAudit(ctx, {
    action: 'platform.bundle.load',
    actorType: 'system',
    targetType: 'platformRelease',
    targetId: m.version,
    metadata: { source: 'install', volume, images: copied.length, ...(failed.length ? { failed } : {}) },
  });
  if (failed.length) return { orgId, state: 'partial', version: m.version, copied, failed };
  await importRelease(ctx, { manifest: read.manifest, signature: read.signature }, { adopt: false }).catch(() => undefined);
  await deps.hub.dispatch(node, 'volume.remove', { name: volume, cluster: false }).catch(() => undefined);
  return { orgId, state: 'seeded', version: m.version, copied };
}

/** Every org with the built-in registry on (a self-host install has one). */
export async function seedFromBundleAllOrgs(deps: Deps, volume: string): Promise<BundleSeedResult[]> {
  const out: BundleSeedResult[] = [];
  for (const { orgId } of await allOrgRows(deps, registryConfigs, { where: { enabled: true } })) {
    out.push(
      await seedRegistryFromBundle(deps, orgId, volume).catch((e) => ({
        orgId,
        state: 'skipped' as const,
        detail: e instanceof Error ? e.message : String(e),
      })),
    );
  }
  return out;
}
