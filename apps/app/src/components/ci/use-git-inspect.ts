import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/**
 * `gitConnections.inspect` — read a linked commit on a builder. Owned by the
 * wizard card and fired from the link's onSuccess (not an effect), so the
 * read happens exactly once per link.
 */
export function useGitInspect() {
  const trpc = useTRPC();
  return useMutation(trpc.gitConnections.inspect.mutationOptions());
}

export type GitInspect = ReturnType<typeof useGitInspect>;
