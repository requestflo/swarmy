/**
 * Offline-bundle seed worker (`install-swarmy.sh --bundle`, a fresh
 * air-gapped install). Dormant unless the installer deployed the controller
 * with `SWARMY_BUNDLE_VOLUME`. Every minute, once the built-in registry runs
 * (the system-image-mirror worker deploys it), copy the bundle's images into
 * it from the volume on node #1 and stamp the mirror labels
 * (`seedFromBundleAllOrgs`). Stops once seeded; gives up after a signature
 * failure, or after a few tries that found no bundle or lost an image (the
 * operator can still load it in Settings › Platform › Import release).
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { bundleVolume, seedFromBundleAllOrgs } from '@swarmy/trpc';
import { hub } from '../gateway';

const INTERVAL_MS = 60 * 1000;
const MAX_TRIES = 10;

export function startBundleSeed(): () => void {
  const volume = bundleVolume();
  if (!volume) return () => undefined;
  let running = false;
  let tries = 0;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const results = await seedFromBundleAllOrgs({ db: prisma, hub, auth: authRegistry.getAuth() }, volume);
      for (const r of results) {
        if (r.state === 'skipped') continue;
        // eslint-disable-next-line no-console
        console.log(
          `[bundle-seed] org ${r.orgId}: ${r.state}${r.version ? ` ${r.version}` : ''}` +
            `${r.copied ? `, ${r.copied.length} image(s)` : ''}${r.failed?.length ? `, failed ${r.failed.join(',')}` : ''}${r.detail ? ` (${r.detail})` : ''}`,
        );
        if (r.state === 'seeded' || r.state === 'unverified' || ++tries >= MAX_TRIES) stopped = true;
      }
      if (results.some((r) => r.detail?.startsWith('already seeded'))) stopped = true;
    } catch {
      // Never let the seed take the controller down; the bundle stays on the node.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, INTERVAL_MS);
  return () => clearInterval(timer);
}
