import type { DomainResolvers } from '../types';

/**
 * Managed-cache demo resolvers — the cache surface of Data services (`/data`):
 * valkey/redis clusters, stats, attach and snapshots.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The A3 managed-cache slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const cache: DomainResolvers = {
  handlers: {},
};
