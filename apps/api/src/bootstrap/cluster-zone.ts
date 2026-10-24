import { prisma } from '@swarmy/db';
import { CLUSTER_ZONE_ENV, ensureClusterZone } from '@swarmy/trpc';
import { hub } from '../gateway';
import { whenSwarmReady } from './when-swarm-ready';

/**
 * `install-swarmy.sh --zone apps.example.com` → `SWARMY_CLUSTER_ZONE`: seed
 * the bootstrap org's cluster zone (plans/self-reliance.md B2b) — a swarmy-ns
 * zone swarmy-dns serves, that answers `<a-b-c-d>.<zone>` itself and becomes
 * the automatic-address base. Created once; a later dashboard change wins.
 */
export function ensureClusterZoneFromEnv(orgId: string): void {
  const zone = process.env[CLUSTER_ZONE_ENV]?.trim();
  if (!zone) return;
  whenSwarmReady('cluster zone', async () => {
    let created = false;
    try {
      created = await ensureClusterZone({ hub, db: prisma }, orgId, zone);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('not a zone name')) throw e;
      // eslint-disable-next-line no-console
      console.log(`[bootstrap] ${CLUSTER_ZONE_ENV}: ${msg} — ignored.`);
      return;
    }
    if (created) {
      // eslint-disable-next-line no-console
      console.log(`[bootstrap] cluster zone ${zone} created — add its NS + glue records at the registrar (Network › Geo-DNS).`);
    }
  });
}
