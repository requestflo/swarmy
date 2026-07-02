import type { DomainResolvers } from '../types';

/**
 * Queues demo resolvers — the Queues surface (`/queues`): queue defs, depth
 * stats, scale rules and DLQ actions.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The B1 queues slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const queues: DomainResolvers = {
  handlers: {},
};
