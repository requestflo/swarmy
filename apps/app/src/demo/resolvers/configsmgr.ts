import type { DomainResolvers } from '../types';

/**
 * Configs-manager demo resolvers — the Configs surface (`/configs`): versions,
 * content diffs, restart previews and rollback.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The E2 configs-mgr slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const configsmgr: DomainResolvers = {
  handlers: {},
};
