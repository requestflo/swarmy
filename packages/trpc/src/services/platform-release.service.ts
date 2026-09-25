/**
 * Platform releases: channel + auto-patch policy, the signed feed, offline
 * bundles, and "which manifest does this cluster run" (plans/epic-platform-upgrades.md).
 *
 *  - {@link checkFeed}: fetch `<feed>/<channel>/platform.json` + `.sig`
 *    (`platformFeedUrl`: org setting → `SWARMY_PLATFORM_FEED_URL` → GitHub
 *    releases), verify OFFLINE against the swarmy release key, store the result
 *    on `PlatformConfig.available`. An unverified release is stored for display
 *    ("unverified release") and can never be started.
 *  - {@link importRelease}: the offline-bundle path — the same verification for
 *    a manifest + signature handed in (Settings → Platform → Import, or the
 *    bundle script), then {@link adoptBundleImages} stamps mirror labels for
 *    the images the bundle already pushed into the built-in registry.
 *  - {@link effectiveImagesFor}: the BOM with the running release's digests —
 *    what the system-image mirror copies and the dispatch decorator deploys by.
 *
 * Every mutation is audited through `writeAudit`.
 */
import { registryConfigs } from './apps.repo';
import type { DB } from '@swarmy/db';
import {
  DEFAULT_MAINTENANCE_WINDOW,
  MaintenanceWindow,
  builtInManifest,
  channelOfVersion,
  compareVersions,
  describeWindow,
  inMaintenanceWindow,
  isPatchUpgrade,
  manifestImages,
  parsePlatformManifest,
  platformFeedUrl,
  upgradeBlockReason,
  type PlatformChannel,
  type PlatformManifest,
} from '@swarmy/core/platform-manifest';
import { releasePublicKey, verifyPlatformManifest } from '@swarmy/core/platform-verify';
import {
  MIRROR_FAIL_MARKER,
  MIRROR_OK_MARKER,
  copyTargetFor,
  mirrorLabelsAfter,
  parseMirrorOutput,
  systemImage,
  type SystemImage,
} from '@swarmy/core/system-images';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { badRequest, commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { REGISTRY_SERVICE_NAME, decodeRegistryCreds } from './registry-auth';
import { canonicalRegistryHost } from './registryPolicy.service';
import { mirrorStateFrom } from './system-images.service';
export { effectiveImagesFor, invalidateEffectiveImages } from './platform-images';

// ── this controller ──────────────────────────────────────────────────────────

/** This controller's build (baked: `SWARMY_VERSION`, `SWARMY_COMMIT`). */
export function controllerBuild(env: Record<string, string | undefined> = process.env): { version: string; commit: string } {
  return { version: env.SWARMY_VERSION?.trim() || '0.0.0', commit: env.SWARMY_COMMIT?.trim() || 'dev' };
}

/** When this process started — the controller step's "did we restart?" signal. */
export const PROCESS_STARTED_AT = Date.now();

// ── config row ───────────────────────────────────────────────────────────────

export interface AvailableRelease {
  manifest: PlatformManifest | null;
  signature: string;
  verified: boolean;
  reason?: string;
  source: 'feed' | 'bundle';
  fetchedAt: string;
}

export interface PlatformPolicy {
  channel: PlatformChannel;
  feedUrl: string | null;
  autoApplyPatches: boolean;
  window: MaintenanceWindow;
}

type ConfigRow = Awaited<ReturnType<DB['platformConfig']['findUnique']>>;

export async function getConfigRow(db: DB, orgId: string): Promise<NonNullable<ConfigRow>> {
  return db.platformConfig.upsert({ where: { orgId }, create: { orgId }, update: {} });
}

function windowOf(raw: unknown): MaintenanceWindow {
  const r = MaintenanceWindow.safeParse(raw);
  return r.success ? r.data : DEFAULT_MAINTENANCE_WINDOW;
}

/**
 * Stored channel values. The column defaults to `stable`, which every row got
 * whether or not anyone chose it, so an Edge install showed "Stable channel"
 * and polled `stable/platform.json` (404). The default now means "follow the
 * installed build" (Edge builds → edge); an explicit choice is stored as
 * `edge` or {@link CHOSEN_STABLE}.
 */
export const CHOSEN_STABLE = 'stable:chosen';

/** PURE — the effective channel for a stored value on a build `version`. */
export function effectiveChannel(stored: string | null | undefined, version: string): PlatformChannel {
  if (stored === 'edge') return 'edge';
  if (stored === CHOSEN_STABLE) return 'stable';
  return channelOfVersion(version);
}

export function policyOf(row: NonNullable<ConfigRow>): PlatformPolicy {
  return {
    channel: effectiveChannel(row.channel, controllerBuild().version),
    feedUrl: row.feedUrl ?? null,
    autoApplyPatches: row.autoApplyPatches,
    window: windowOf(row.window),
  };
}

function availableOf(row: NonNullable<ConfigRow>): AvailableRelease | null {
  const a = row.available as AvailableRelease | null;
  return a && typeof a === 'object' ? a : null;
}

/** The release this cluster runs: the last completed run's manifest, else the controller's built-in BOM. */
export function currentManifestOf(row: { currentManifest: unknown } | null): PlatformManifest {
  if (row?.currentManifest) {
    try {
      return parsePlatformManifest(row.currentManifest);
    } catch {
      // fall through to the built-in BOM
    }
  }
  const b = controllerBuild();
  return builtInManifest(b.version, b.commit);
}

// ── feed ─────────────────────────────────────────────────────────────────────

export type FetchText = (url: string) => Promise<string>;

export const fetchFeedText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
};

/** Verify a manifest + signature against this controller's release key. */
export function verifyRelease(raw: string | object, signature: string): AvailableRelease & { source: 'feed' } {
  const r = verifyPlatformManifest(raw, signature, releasePublicKey());
  return {
    manifest: r.manifest ?? null,
    signature,
    verified: r.ok,
    ...(r.ok ? {} : { reason: r.reason }),
    source: 'feed',
    fetchedAt: new Date().toISOString(),
  };
}

/** Fetch + verify the channel's newest release; store it. Returns what was stored. */
export async function checkFeed(ctx: Pick<OrgContext, 'db' | 'activeOrgId'>, fetchText: FetchText = fetchFeedText): Promise<AvailableRelease | null> {
  const row = await getConfigRow(ctx.db, ctx.activeOrgId);
  const policy = policyOf(row);
  const urls = platformFeedUrl(policy.channel, policy.feedUrl);
  try {
    const [raw, sig] = await Promise.all([fetchText(urls.manifest), fetchText(urls.signature).catch(() => '')]);
    const rel = verifyRelease(raw, sig);
    if (rel.manifest && rel.manifest.channel !== policy.channel) {
      rel.verified = false;
      rel.reason = `the feed served a ${rel.manifest.channel} release on the ${policy.channel} channel`;
    }
    await ctx.db.platformConfig.update({
      where: { orgId: ctx.activeOrgId },
      data: { available: rel as object, lastCheckAt: new Date(), lastCheckError: null },
    });
    return rel;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await ctx.db.platformConfig.update({
      where: { orgId: ctx.activeOrgId },
      data: { lastCheckAt: new Date(), lastCheckError: message.slice(0, 500) },
    });
    return availableOf(row);
  }
}

/** Offline-bundle / manual import: verify and store as the available release. */
export async function importRelease(ctx: OrgContext, input: { manifest: string; signature: string }): Promise<AvailableRelease> {
  const rel: AvailableRelease = { ...verifyRelease(input.manifest, input.signature), source: 'bundle' };
  if (!rel.manifest) throw badRequest(rel.reason ?? 'not a platform manifest');
  if (!rel.verified) throw commandRejected(`unverified release: ${rel.reason}`);
  await getConfigRow(ctx.db, ctx.activeOrgId);
  await ctx.db.platformConfig.update({ where: { orgId: ctx.activeOrgId }, data: { available: rel as object } });
  await writeAudit(ctx, {
    action: 'platform.release.import',
    targetType: 'platformRelease',
    targetId: rel.manifest.version,
    metadata: { version: rel.manifest.version, channel: rel.manifest.channel, commit: rel.manifest.commit },
  });
  // Images a bundle pushed into the built-in registry become trusted mirror
  // copies (best-effort: without a registry the run pulls upstream).
  void adoptBundleImages(ctx, rel.manifest).catch(() => undefined);
  return rel;
}

/**
 * The regctl one-shot that CHECKS (never copies) which of the release's images
 * are already in the built-in registry at the mirror paths — what an offline
 * bundle pushed — and prints the mirror copier's OK/FAIL markers. Pure.
 */
export function renderAdoptScript(items: readonly SystemImage[], registryHost: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = [
    'set -u',
    `regctl registry set ${q(registryHost)} --tls disabled >/dev/null 2>&1 || true`,
    `if [ -n "\${SWARMY_REG_USER:-}" ]; then printf '%s' "$SWARMY_REG_PASS" | regctl registry login ${q(registryHost)} -u "$SWARMY_REG_USER" --pass-stdin >/dev/null 2>&1 || true; fi`,
  ];
  for (const img of items) {
    if (!img.digest) continue;
    lines.push(
      `D=$(regctl image digest ${q(copyTargetFor(img, registryHost))} 2>/dev/null); if [ "$D" = ${q(img.digest)} ]; then echo "${MIRROR_OK_MARKER} ${img.key} $D"; else echo "${MIRROR_FAIL_MARKER} ${img.key}"; fi`,
    );
  }
  return lines.join('\n');
}

export async function adoptBundleImages(ctx: OrgContext, manifest: PlatformManifest): Promise<{ adopted: string[] }> {
  const reg = await registryConfigs(ctx, ctx.activeOrgId).findUnique({ where: { orgId: ctx.activeOrgId }, select: { enabled: true, host: true, credentialsEnc: true } });
  if (!reg?.enabled) return { adopted: [] };
  const manager = ctx.hub.managerNode(ctx.activeOrgId);
  if (!manager) return { adopted: [] };
  const state = mirrorStateFrom(ctx.hub.liveInventory(ctx.activeOrgId));
  if (!state.registryNodeId) return { adopted: [] };
  const host = canonicalRegistryHost(reg.host);
  const images = manifestImages(manifest);
  const creds = decodeRegistryCreds(reg.credentialsEnc);
  const res = await ctx.hub.dispatch<RunOnceResult>(
    manager,
    'container.runOnce',
    {
      image: systemImage('regctl').ref,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [renderAdoptScript(images, host)],
      env: creds ? { SWARMY_REG_USER: creds.username, SWARMY_REG_PASS: creds.password } : {},
      networks: ['host'],
      timeoutMs: 5 * 60_000,
    },
    { timeoutMs: 6 * 60_000 },
  );
  const out = parseMirrorOutput(res.output);
  if (!out.ok.size) return { adopted: [] };
  const { add } = mirrorLabelsAfter(state.labels, state.registryNodeId, out.ok, images);
  await ctx.hub.dispatch(manager, 'service.updateLabels', { service: REGISTRY_SERVICE_NAME, add, removeKeys: [] });
  return { adopted: [...out.ok.keys()] };
}

// ── policy ───────────────────────────────────────────────────────────────────

export async function setPolicy(
  ctx: OrgContext,
  input: { channel?: PlatformChannel; feedUrl?: string | null; autoApplyPatches?: boolean; window?: MaintenanceWindow },
): Promise<PlatformPolicy> {
  if (input.feedUrl && !/^https:\/\//i.test(input.feedUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(input.feedUrl)) {
    throw badRequest('the feed URL must be https://');
  }
  const before = policyOf(await getConfigRow(ctx.db, ctx.activeOrgId));
  const row = await ctx.db.platformConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      ...(input.channel ? { channel: input.channel === 'stable' ? CHOSEN_STABLE : 'edge' } : {}),
      ...(input.feedUrl !== undefined ? { feedUrl: input.feedUrl?.trim() || null } : {}),
      ...(input.autoApplyPatches !== undefined ? { autoApplyPatches: input.autoApplyPatches } : {}),
      ...(input.window ? { window: input.window as object } : {}),
      // A channel switch invalidates the stored release (it was the other stream's).
      ...(input.channel && input.channel !== before.channel ? { available: null as never } : {}),
    },
  });
  const after = policyOf(row);
  await writeAudit(ctx, {
    action: 'platform.policy.set',
    targetType: 'platformConfig',
    targetId: row.id,
    metadata: { before, after },
  });
  return after;
}

// ── auto-apply decision (pure) ───────────────────────────────────────────────

/**
 * Should the cluster start an automatic upgrade now? Only a verified PATCH
 * release, only with auto-apply on, only inside the window, never while a run
 * is going or after the same target already failed (a human looks first). Pure.
 */
export function shouldAutoApply(i: {
  policy: PlatformPolicy;
  current: string;
  available: AvailableRelease | null;
  running: boolean;
  lastFailedTarget: string | null;
  now: Date;
}): { go: true; version: string } | { go: false; why: string } {
  if (!i.policy.autoApplyPatches) return { go: false, why: 'auto-apply is off' };
  if (i.running) return { go: false, why: 'an upgrade is already running' };
  const m = i.available?.manifest;
  if (!m || !i.available?.verified) return { go: false, why: 'no verified release' };
  if (!isPatchUpgrade(i.current, m.version)) return { go: false, why: `${m.version} is not a patch release of ${i.current}` };
  if (i.lastFailedTarget === m.version) return { go: false, why: `the last automatic attempt at ${m.version} failed — waiting for an admin` };
  if (!inMaintenanceWindow(i.policy.window, i.now)) return { go: false, why: `outside the window (${describeWindow(i.policy.window)})` };
  return { go: true, version: m.version };
}

// ── view ─────────────────────────────────────────────────────────────────────

export interface PlatformReleaseView {
  controller: { version: string; commit: string };
  current: { version: string; channel: PlatformChannel; commit: string; publishedAt: string; builtIn: boolean };
  available: {
    version: string;
    channel: PlatformChannel;
    commit: string;
    publishedAt: string;
    notes: PlatformManifest['notes'];
    migrations: PlatformManifest['migrations'];
    verified: boolean;
    reason: string | null;
    source: 'feed' | 'bundle';
    /** Why Upgrade is disabled (null = it can start). */
    blocked: string | null;
    patch: boolean;
    components: Array<{ key: string; image: string; tag: string | null; digest: string | null; changed: boolean }>;
  } | null;
  policy: PlatformPolicy & { windowText: string; feed: string };
  lastCheckAt: string | null;
  lastCheckError: string | null;
}

export async function getReleaseView(ctx: Pick<OrgContext, 'db' | 'activeOrgId'>): Promise<PlatformReleaseView> {
  const row = await getConfigRow(ctx.db, ctx.activeOrgId);
  const policy = policyOf(row);
  const cur = currentManifestOf(row);
  const av = availableOf(row);
  const m = av?.manifest ?? null;
  let blocked: string | null = null;
  if (m) {
    blocked = !av?.verified ? `unverified release: ${av?.reason ?? 'signature check failed'}` : upgradeBlockReason(cur.version, m);
  }
  return {
    controller: controllerBuild(),
    current: {
      version: cur.version,
      channel: cur.channel,
      commit: cur.commit,
      publishedAt: cur.publishedAt,
      builtIn: !row.currentManifest,
    },
    available:
      m && av && compareVersions(m.version, cur.version) > 0
        ? {
            version: m.version,
            channel: m.channel,
            commit: m.commit,
            publishedAt: m.publishedAt,
            notes: m.notes,
            migrations: m.migrations,
            verified: av.verified,
            reason: av.reason ?? null,
            source: av.source,
            blocked,
            patch: isPatchUpgrade(cur.version, m.version),
            components: Object.entries(m.components)
              .map(([key, c]) => ({
                key,
                image: c.image,
                tag: c.tag ?? null,
                digest: c.digest ?? null,
                changed: (cur.components[key]?.digest ?? null) !== (c.digest ?? null),
              }))
              .sort((a, b) => a.key.localeCompare(b.key)),
          }
        : null,
    policy: { ...policy, windowText: describeWindow(policy.window), feed: platformFeedUrl(policy.channel, policy.feedUrl).manifest },
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
    lastCheckError: row.lastCheckError ?? null,
  };
}
