/**
 * Which image digests this org's system services should run — the BOM with
 * the digests of the release the cluster is on (plans/epic-platform-upgrades.md).
 * Read by the system-image mirror (what to copy) and the hub dispatch
 * decorator (what to deploy by). Own module (no service imports) so both can
 * use it without an import cycle.
 */
import type { DB } from '@swarmy/db';
import { manifestImages, parsePlatformManifest } from '@swarmy/core/platform-manifest';
import { SYSTEM_IMAGES, type SystemImage } from '@swarmy/core/system-images';

const IMAGES_TTL_MS = 30_000;
const imagesCache = new Map<string, { at: number; images: readonly SystemImage[] }>();

export function invalidateEffectiveImages(orgId?: string): void {
  if (orgId) imagesCache.delete(orgId);
  else imagesCache.clear();
}

/**
 * The BOM with the digests of the release this cluster should run: a running
 * upgrade's target once its controller step is done (the new controller's
 * services converge to it), else the current release. Never throws: any
 * failure is the compiled BOM.
 */
export async function effectiveImagesFor(db: DB, orgId: string): Promise<readonly SystemImage[]> {
  const hit = imagesCache.get(orgId);
  if (hit && Date.now() - hit.at < IMAGES_TTL_MS) return hit.images;
  let images: readonly SystemImage[] = SYSTEM_IMAGES;
  try {
    const run = await db.platformUpgradeRun.findFirst({
      where: { orgId, status: 'running' },
      orderBy: { startedAt: 'desc' },
      select: { manifest: true, steps: true },
    });
    const ctrlDone = (run?.steps as Array<{ key: string; status: string }> | undefined)?.some(
      (s) => s.key === 'controller' && (s.status === 'done' || s.status === 'skipped'),
    );
    if (run && ctrlDone) images = manifestImages(parsePlatformManifest(run.manifest));
    else {
      const row = await db.platformConfig.findUnique({ where: { orgId }, select: { currentManifest: true } });
      if (row?.currentManifest) images = manifestImages(parsePlatformManifest(row.currentManifest));
    }
  } catch {
    images = SYSTEM_IMAGES;
  }
  imagesCache.set(orgId, { at: Date.now(), images });
  return images;
}

