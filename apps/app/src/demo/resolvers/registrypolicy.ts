import type { DomainResolvers } from '../types';

/**
 * Registry-policy demo resolvers — image scan results, signing status and
 * admission policy toggles on the registry panel.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The D3 image-policy slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const registrypolicy: DomainResolvers = {
  handlers: {},
};
