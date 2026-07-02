import type { DomainResolvers } from '../types';

/**
 * Exposure demo resolvers — the Exposure surface (`/exposure`): per-service
 * public/private/protected verdicts, rules and violations.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The E3 exposure slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const exposure: DomainResolvers = {
  handlers: {},
};
