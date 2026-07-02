import type { DomainResolvers } from '../types';

/**
 * AI-gateway demo resolvers — the AI surface (`/ai`): providers, virtual keys,
 * usage/cost queries and request logs.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F5 ai slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const ai: DomainResolvers = {
  handlers: {},
};
