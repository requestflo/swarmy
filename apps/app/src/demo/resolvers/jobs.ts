import type { DomainResolvers } from '../types';

/**
 * Scheduled-jobs demo resolvers — the Jobs surface (`/jobs`): cron jobs,
 * run-now, run history and output tails.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The B2 jobs slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const jobs: DomainResolvers = {
  handlers: {},
};
