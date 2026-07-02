import type { DomainResolvers } from '../types';

/**
 * Managed-search demo resolvers — the search surface of Data services (`/data`):
 * meilisearch/typesense clusters, keys and attach.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F4 managed-search slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const searchsvc: DomainResolvers = {
  handlers: {},
};
