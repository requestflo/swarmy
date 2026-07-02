import type { DomainResolvers } from '../types';

/**
 * Inbound webhook gateway demo resolvers — the Webhooks surface (`/webhooks`):
 * endpoints, deliveries, replay and dead letters.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The B4 webhook-gateway slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const webhookgw: DomainResolvers = {
  handlers: {},
};
