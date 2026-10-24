import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/** Mirrors AppConfigFileView (packages/trpc/src/services/apps/config-file.ts). */
export interface ConfigFileView {
  repoId: string;
  environment: string;
  path: string;
  sha: string;
  text: string | null;
  fetchedAt: string;
  lastWebhookAt: string | null;
  lastPollAt: string | null;
  previewDomain: string | null;
}

/**
 * The swarmy.yaml a git app runs from (`apps.configFile`: its last planned
 * commit, read through the GitOps loop's own inspect path and cached per
 * commit on the controller). A miss runs on a Builder, so it's polled
 * gently and never retried in a loop.
 */
export function useConfigFile(stack: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.apps.configFile.queryOptions({ stack }),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/**
 * The compose swarmy compiled from swarmy.yaml and deployed last — the
 * newest release's compose source (credentials never enter it).
 */
export function useDeployedCompose(stack: string, enabled: boolean) {
  const trpc = useTRPC();
  const list = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 1 }), enabled });
  const id = list.data?.[0]?.id;
  const release = useQuery({ ...trpc.releases.get.queryOptions({ id: id ?? '' }), enabled: enabled && Boolean(id) });
  return {
    release: release.data,
    pending: enabled && (list.isPending || (Boolean(id) && release.isPending)),
    none: list.data?.length === 0,
  };
}
