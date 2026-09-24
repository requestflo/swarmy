import { useQuery } from '@tanstack/react-query';
import { useTRPCClient } from '@/integrations/trpc';
import { useDebouncedValue } from './use-debounced-value';

interface InspectSourceInput {
  connectionId?: string;
  cloneUrl: string;
  ref: string;
}

/**
 * Peek inside a repo BEFORE linking (`gitConnections.inspectSource`) to find
 * its swarmy.yaml files. The procedure is a mutation (it runs a container on a
 * builder), but the read is idempotent, so it's cached as a query keyed on the
 * source — re-picking the same repo + branch doesn't re-run it.
 */
export function useInspectSource(input: InspectSourceInput | null) {
  const client = useTRPCClient();
  // Debounce a string, not the object — callers build a fresh object per render.
  const key = useDebouncedValue(input ? JSON.stringify(input) : '', 500);
  const settled = key ? (JSON.parse(key) as InspectSourceInput) : null;
  return useQuery({
    queryKey: ['gitConnections.inspectSource', key],
    queryFn: () => client.gitConnections.inspectSource.mutate(settled as InspectSourceInput),
    enabled: Boolean(settled?.cloneUrl && settled.ref),
    staleTime: Infinity,
    retry: false,
  });
}
