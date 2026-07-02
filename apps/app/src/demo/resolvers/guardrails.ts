import type { DomainResolvers } from '../types';

/**
 * Guardrails demo resolvers — the Governance surface (`/governance`): rule
 * toggles, production safety mode and blocked actions.
 *
 * Spine stub — registered in `registry.ts` by the spine so slices never edit
 * shared files. The E4 guardrails slice fills in handlers (+ seed) with realistic
 * demo data, mirroring its tRPC service views exactly.
 */
export const guardrails: DomainResolvers = {
  handlers: {},
};
