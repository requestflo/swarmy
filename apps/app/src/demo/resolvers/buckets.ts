import type { DomainResolvers } from '../types';

/**
 * Object-storage demo resolvers — the buckets surface of Data services (`/data`):
 * Garage buckets, access keys, quotas and usage.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The A4 object-storage slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const buckets: DomainResolvers = {
  handlers: {},
};
