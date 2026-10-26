/**
 * Reindex by swap (board 41). swarmy doesn't hold an app's source data (the
 * rows a search index is built from live in the app's database, shaped by
 * the app's own code), so it can't rebuild an index itself. What it can do is
 * the engine's swap-index pattern: the app (or a one-off job) writes a full
 * rebuild into a second index on the same instance, and swarmy swaps the two
 * atomically (Meilisearch `POST /swap-indexes`) — searches answer from the old
 * documents until the swap lands and never from an empty index; the old
 * documents end up under the other name. Shared by the controller and the
 * dashboard. Pure.
 */
import { z } from 'zod';
import { SearchIndexRef, SearchIndexUid } from './search-indexes';

export const SwapSearchIndexInput = SearchIndexRef.extend({
  /** The index holding the rebuild (`products_next`). */
  with: SearchIndexUid,
  /** Typed confirmation: the live index's name. */
  confirm: z.string().max(100),
});
export type SwapSearchIndexInput = z.infer<typeof SwapSearchIndexInput>;

export interface SearchSwapResult {
  index: string;
  with: string;
  taskUid: number | null;
  status: 'succeeded' | 'failed' | 'processing' | 'enqueued' | 'canceled';
  error: string | null;
}

/** What makes a swap unsafe, in plain words; null = fine. Both sides as the engine reports them. */
export function swapProblem(
  live: { uid: string; primaryKey: string | null; docs: number },
  next: { uid: string; primaryKey: string | null; docs: number; isIndexing?: boolean },
): string | null {
  if (live.uid === next.uid) return 'pick another index to swap in';
  if (next.docs === 0) return `${next.uid} has no documents: swapping it in would empty ${live.uid}`;
  if (next.isIndexing) return `${next.uid} is still taking documents in; swap once it has finished`;
  if (live.primaryKey && next.primaryKey && live.primaryKey !== next.primaryKey) {
    return `${next.uid} keys its documents by ${next.primaryKey} and ${live.uid} by ${live.primaryKey}: it's a different index, not a rebuild of this one`;
  }
  return null;
}
