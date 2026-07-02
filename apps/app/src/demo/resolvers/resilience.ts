import type { DomainResolvers } from '../types';

/**
 * Resilience demo resolvers — the Resilience surface (`/resilience`): readiness
 * score, problems and safe drills.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F2 resilience slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const resilience: DomainResolvers = {
  handlers: {},
};
