import type { DomainResolvers } from '../types';

/**
 * Cost demo resolvers — the Cost surface (`/cost`): node costs, per-stack
 * shares, idle services and recommendations.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F1 cost slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const cost: DomainResolvers = {
  handlers: {},
};
