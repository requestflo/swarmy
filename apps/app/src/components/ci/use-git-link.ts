import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { LinkedRepo } from './git-types';
import { useGitInspect } from './use-git-inspect';

/**
 * The wizard's last step: link the repo + branch + swarmy.yaml as an app
 * (`gitConnections.linkRepo`), then read that commit on a builder
 * (`inspect`). Linking deploys nothing; the next push (or Deploy now) does.
 */
export function useGitLink() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [linked, setLinked] = React.useState<LinkedRepo | null>(null);
  const inspect = useGitInspect();

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: trpc.cicd.listRepos.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.gitConnections.list.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.apps.list.queryKey() });
  };
  const link = useMutation(
    trpc.gitConnections.linkRepo.mutationOptions({
      onSuccess: (res) => {
        setLinked(res);
        inspect.mutate({ repoId: res.id });
        toast.success(`${res.fullName ?? res.url} is linked.`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.gitConnections.updateRepo.mutationOptions({
      onSuccess: (res) => {
        setLinked((l) => (l ? { ...l, branch: res.branch, configPath: res.configPath } : l));
        toast.success(`Now deploying ${res.configPath}.`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return { linked, link, inspect, update };
}

export type GitLink = ReturnType<typeof useGitLink>;
