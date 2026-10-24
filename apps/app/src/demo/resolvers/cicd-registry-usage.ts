import type { DomainResolvers } from '../types';

/**
 * Demo resolver for `cicd.getRegistryUsage` (registry-usage.ts →
 * RegistryUsageView): the registry's measured size and image counts, plus the
 * last cleanup the 6h GC tick did, so the CI & registry page's "Space used"
 * row has believable numbers with no backend (board 51).
 */

interface RegistryUsageView {
  sizeBytes: number;
  repos: number;
  images: number;
  measuredAt: string;
  lastGc: { at: string; deleted: number; reclaimedBytes: number | null } | null;
}

const HOUR = 3_600_000;
const GB = 1024 ** 3;

export const cicdRegistryUsage: DomainResolvers = {
  handlers: {
    'cicd.getRegistryUsage': (): RegistryUsageView => {
      const now = Date.now();
      return {
        sizeBytes: Math.round(3.4 * GB),
        repos: 9,
        images: 46,
        measuredAt: new Date(now - 2 * HOUR).toISOString(),
        lastGc: { at: new Date(now - 2 * HOUR).toISOString(), deleted: 31, reclaimedBytes: Math.round(1.2 * GB) },
      };
    },
  },
};
