import type { DomainResolvers } from '../types';

/**
 * Secrets-manager demo resolvers — the Secrets surface (`/secrets`): families,
 * versions, rotation and usage maps.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The E1 secrets-mgr slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const secretsmgr: DomainResolvers = {
  handlers: {},
};
