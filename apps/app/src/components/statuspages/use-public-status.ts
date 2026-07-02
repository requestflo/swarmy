import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import type { PublicStatusView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { isDemo } from '@/demo/is-demo';

/**
 * The public snapshot behind `/s/$slug`. Real mode fetches the UNAUTHENTICATED
 * `GET /status/<slug>.json` with plain fetch (no tRPC, no session); demo mode
 * resolves the same shape through the demo link (`statusPages.preview`), since
 * there is no controller to answer the JSON route.
 */
async function fetchSnapshot(slug: string): Promise<PublicStatusView> {
  const res = await fetch(`/status/${encodeURIComponent(slug)}.json`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`The status service answered ${res.status} — try again shortly.`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // Dev without a `/status` proxy (or a misrouted domain) lands on the SPA shell.
    throw new Error('The status service is unreachable from this origin.');
  }
  return (await res.json()) as PublicStatusView;
}

export function usePublicStatus(slug: string): UseQueryResult<PublicStatusView, Error> {
  const trpc = useTRPC();
  const demoOptions = trpc.statusPages.preview.queryOptions({ slug });
  const options: UseQueryOptions<PublicStatusView, Error> = isDemo()
    ? ({
        ...demoOptions,
        refetchInterval: 30_000,
        retry: false,
      } as unknown as UseQueryOptions<PublicStatusView, Error>)
    : {
        queryKey: ['public-status', slug],
        queryFn: () => fetchSnapshot(slug),
        refetchInterval: 30_000,
        retry: 1,
      };
  return useQuery(options);
}
