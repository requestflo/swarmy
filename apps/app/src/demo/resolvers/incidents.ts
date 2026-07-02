import type { DomainResolvers } from '../types';

/**
 * Incidents demo resolvers — the Incidents surface (`/incidents`): open/past
 * incidents, timelines and post-mortem notes.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The C4 incidents slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const incidents: DomainResolvers = {
  handlers: {},
};
