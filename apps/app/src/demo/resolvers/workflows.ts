import type { DomainResolvers } from '../types';

/**
 * Workflow-engine demo resolvers — the Workflows surface (`/workflows`): defs,
 * runs, step timelines and approvals.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The B3 workflow-engine slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const workflows: DomainResolvers = {
  handlers: {},
};
