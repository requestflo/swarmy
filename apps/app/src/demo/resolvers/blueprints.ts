import type { DomainResolvers } from '../types';

/**
 * Blueprints demo resolvers — the Blueprints gallery (`/blueprints`): catalog,
 * plan previews and deploys.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F3 blueprints slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const blueprints: DomainResolvers = {
  handlers: {},
};
