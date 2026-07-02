import type { DomainResolvers } from '../types';

/**
 * Alerting demo resolvers — the Alerts surface (`/alerts`): rules, notification
 * channels and the firing/resolved event feed.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The C3 alerts slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const alerts: DomainResolvers = {
  handlers: {},
};
