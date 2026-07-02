import type { DomainResolvers } from '../types';

/**
 * Audit-pack demo resolvers — the Audit surface (`/audit`): filterable audit
 * timeline, canned queries and exports.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The E5 audit-pack slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const auditlog: DomainResolvers = {
  handlers: {},
};
