import type { DomainResolvers } from '../types';

/**
 * Preview-environments demo resolvers — the Previews tab on CI: PR stacks,
 * URLs, TTLs and teardown.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The D4 previews slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const previews: DomainResolvers = {
  handlers: {},
};
