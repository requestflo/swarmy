import type { DomainResolvers } from '../types';

/**
 * Vector-store demo resolvers — the vector surface of Data services (`/data`):
 * qdrant/pgvector stores and attach.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F5 ai slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const vector: DomainResolvers = {
  handlers: {},
};
