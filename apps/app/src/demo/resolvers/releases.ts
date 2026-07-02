import type { DomainResolvers } from '../types';

/**
 * Releases demo resolvers — the Releases surface (`/releases`): deploy history,
 * health gates, diffs and rollback.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The D1 releases slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const releases: DomainResolvers = {
  handlers: {},
};
