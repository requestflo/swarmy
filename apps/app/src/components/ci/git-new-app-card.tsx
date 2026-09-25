import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ErrorState, TextSkeleton } from '@/components/states';
import { GitLinkDetect } from './git-link-detect';
import { GitLinkSecrets } from './git-link-secrets';
import { GitNewAppForm } from './git-new-app-form';
import type { LinkedRepo } from './git-types';
import { useGitInspect } from './use-git-inspect';

interface GitNewAppCardProps {
  initialConnectionId?: string;
  onClose: () => void;
}

/** "New app from Git": the wizard, then the one-time reveal + what we found in the repo. */
export function GitNewAppCard({
  initialConnectionId,
  onClose,
}: GitNewAppCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const connections = useQuery(trpc.gitConnections.list.queryOptions());
  const [linked, setLinked] = React.useState<LinkedRepo | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: trpc.cicd.listRepos.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.gitConnections.list.queryKey() });
  };
  const inspect = useGitInspect();
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

  const body = connections.isPending ? (
    <TextSkeleton className="h-24 w-full rounded-xl" />
  ) : connections.isError ? (
    <ErrorState error={connections.error} retry={() => void connections.refetch()} />
  ) : linked ? (
    <div className="space-y-5">
      <p className="text-lg font-semibold">
        Linked <span className="mono-data">{linked.fullName ?? linked.url}</span> on{' '}
        <span className="mono-data">{linked.branch}</span>.
      </p>
      <GitLinkSecrets linked={linked} />
      <GitLinkDetect
        linked={linked}
        inspect={inspect}
        switching={update.isPending}
        onUsePath={(configPath) => update.mutate({ id: linked.id, configPath })}
      />
      <div className="flex justify-end">
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  ) : (
    <GitNewAppForm
      connections={connections.data}
      initialConnectionId={initialConnectionId}
      linking={link.isPending}
      onLink={(req) => link.mutate(req)}
      onCancel={onClose}
    />
  );

  return (
    <Card className="calm-card mb-6 overflow-hidden border-0">
      <CardHeader>
        <CardTitle className="text-base">New app from Git</CardTitle>
        <CardDescription>
          Pick a repo and a branch. Every push builds on your servers and ships.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
