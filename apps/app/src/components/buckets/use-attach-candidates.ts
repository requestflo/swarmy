import { useQueries, useQuery } from '@tanstack/react-query';
import { UNGROUPED } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { attachCandidates, attachmentMap, type AttachCandidate } from './attach-plan';

/**
 * The apps a bucket can be attached to, and — for the picked app — which of
 * its services can take it (from the live inventory and every bucket's
 * attachments; a service holds one bucket at most).
 */
export function useAttachCandidates(app: string | null): { apps: string[]; candidates: AttachCandidate[] | undefined } {
  const trpc = useTRPC();
  const inventory = useQuery(trpc.inventory.get.queryOptions());
  const overview = useQuery(trpc.buckets.overview.queryOptions());
  const details = useQueries({
    queries: (app ? (overview.data?.buckets ?? []) : []).map((b) => trpc.buckets.get.queryOptions({ bucketId: b.id })),
  });
  const apps = (inventory.data?.projects ?? []).map((p) => p.name).filter((n) => n !== UNGROUPED && n !== 'swarmy-system');
  const ready = app && inventory.data && overview.data && details.every((q) => q.data);
  return {
    apps,
    candidates: ready ? attachCandidates(app, inventory.data!.services, attachmentMap(details.map((q) => q.data))) : undefined,
  };
}
