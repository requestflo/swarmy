import { useQuery } from '@tanstack/react-query';
import { useTRPCClient } from '@/integrations/trpc';
import { parseManifest } from './git-manifest';

export interface ManifestInput {
  githubOrg?: string;
  webBase?: string;
}

/**
 * The GitHub App manifest swarmy will post, read before you go
 * (`gitConnections.startGithubManifest`). The procedure is a mutation, but it
 * only builds the JSON and signs a 10-minute state — nothing exists until
 * GitHub calls back — so it is cached as a query keyed on its input. Create
 * mints a fresh one (a full 10 minutes) and posts that.
 */
export function useGithubManifest(input: ManifestInput | null) {
  const client = useTRPCClient();
  const key = input ? JSON.stringify(input) : '';
  return useQuery({
    queryKey: ['gitConnections.startGithubManifest', 'preview', key],
    queryFn: async () => parseManifest((await client.gitConnections.startGithubManifest.mutate(input ?? {})).manifest),
    enabled: input !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
