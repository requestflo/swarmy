import type { DomainResolvers } from '../types';

/**
 * Status-pages demo resolvers — the Status pages surface (`/status-pages`) plus
 * the public `/s/$slug` snapshot.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The C5 status-pages slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const statuspages: DomainResolvers = {
  handlers: {},
};
