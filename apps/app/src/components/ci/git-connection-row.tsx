import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { GitBranchIcon, GithubIcon, GitlabIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { goToProvider } from './git-nav';
import { connectionStatus, KIND_LABEL, type GitConnection } from './git-types';

const ICON = {
  github: GithubIcon,
  gitlab: GitlabIcon,
  gitea: GitBranchIcon,
  generic: GitBranchIcon,
};

/** One provider connection: who it is, how many repos ride on it, install more / remove. */
export function GitConnectionRow({ conn }: { conn: GitConnection }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const Icon = ICON[conn.kind];

  const remove = useMutation(
    trpc.gitConnections.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`${conn.displayName} is disconnected.`);
        void qc.invalidateQueries({ queryKey: trpc.gitConnections.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const install = useMutation(
    trpc.gitConnections.githubInstallLink.mutationOptions({
      onSuccess: ({ url }) => goToProvider(url, navigate),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="hover:bg-accent/60 flex flex-wrap items-center gap-4 px-6 py-4 transition-colors">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{conn.displayName}</p>
        <p className="text-muted-foreground mono-label truncate">
          {KIND_LABEL[conn.kind]}
          {conn.account ? ` · ${conn.account}` : ''} · {conn.repoCount} repo
          {conn.repoCount === 1 ? '' : 's'}
        </p>
      </div>
      <StatusBadge {...connectionStatus(conn.status)} />
      {conn.kind === 'github' ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => install.mutate(undefined)}
          disabled={install.isPending}
        >
          <PlusIcon className="size-4" /> Install on more repos
        </Button>
      ) : null}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Disconnect ${conn.displayName}`}>
            <Trash2Icon className="size-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {conn.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              swarmy forgets this connection’s credentials. Repos linked through it stop getting new
              builds until you connect again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate({ id: conn.id })}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
