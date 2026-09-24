/**
 * System-image mirror worker (self-reliance B3/B4).
 *
 * On controller boot (so: at install) and every 6h, for every org whose
 * built-in registry is enabled: make sure the registry and the Docker Hub
 * pull-through cache are deployed, then copy swarmy's images and the upstream
 * system images (BOM: `@swarmy/core/system-images`) into the registry by
 * digest. From then on the hub decorator deploys them from the cluster.
 *
 * Install-time default: on a self-host bootstrap (`SWARMY_BOOTSTRAP=1`) the
 * bootstrap org gets the built-in registry enabled when it has NO registry
 * config yet — an operator who disabled it keeps that choice.
 * `SWARMY_BUILTIN_REGISTRY=0` opts out.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { ensureRegistryDeployed, mirrorSystemImagesAllOrgs, registryConfigs, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

const MIRROR_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Nodes reconnect + the hub warms up before the first copy. */
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

async function enableBuiltinRegistryAtInstall(): Promise<void> {
  if (process.env.SWARMY_BOOTSTRAP !== '1' || process.env.SWARMY_BUILTIN_REGISTRY === '0') return;
  const slug = process.env.SWARMY_ORG_SLUG ?? 'swarmy';
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  if (!org) return;
  // The registry config lives in the org's swarm (swarm-kv): this throws (and
  // the caller retries) until a manager agent is connected.
  const configs = registryConfigs({ db: prisma, hub }, org.id);
  if (await configs.findFirst()) return;
  await configs.create({ data: { enabled: true, host: 'localhost:5000' } });
  // eslint-disable-next-line no-console
  console.log('[system-image-mirror] built-in registry enabled for the bootstrap org.');
}

export function startSystemImageMirror(): () => void {
  let running = false;
  const deps = () => ({ db: prisma, hub, auth: authRegistry.getAuth() });
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await enableBuiltinRegistryAtInstall().catch(() => {
        setTimeout(() => void enableBuiltinRegistryAtInstall().catch(() => undefined), 60_000).unref?.();
      });
      const results = await mirrorSystemImagesAllOrgs(deps(), (d, orgId) => ensureRegistryDeployed(systemContext(d, orgId)));
      for (const r of results) {
        if (r.copied.length || r.failed.length) {
          // eslint-disable-next-line no-console
          console.log(
            `[system-image-mirror] org ${r.orgId}: copied ${r.copied.length}${r.failed.length ? `, failed ${r.failed.join(',')}` : ''}`,
          );
        }
      }
    } catch {
      // Never let the mirror take the controller down; upstream refs still work.
    } finally {
      running = false;
    }
  };
  const kickoff = setTimeout(run, FIRST_RUN_DELAY_MS);
  const timer = setInterval(run, MIRROR_INTERVAL_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
