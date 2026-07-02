import type { DomainResolvers } from '../types';

/**
 * Notifications demo resolvers — Settings · Notifications (`/settings/notifications`):
 * provider config, templates and the delivery log.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The F6 notifications slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const notify: DomainResolvers = {
  handlers: {},
};
