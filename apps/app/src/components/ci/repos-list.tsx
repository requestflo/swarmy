import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranchIcon, HammerIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { AddRepoDialog } from './add-repo-dialog';

interface RepoRow {
  id: string;
  url: string;
  provider: string;
  branch: string;
  autodeploy: boolean;
  hasToken: boolean;
}

interface ReposListProps {
  repos: RepoRow[];
  onChanged: () => void;
}

/** Flat repo rows inside one card-pop, divided by hairlines. */
export function ReposList({ repos, onChanged }: ReposListProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const removeRepo = useMutation(
    trpc.cicd.removeRepo.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const triggerBuild = useMutation(
    trpc.cicd.triggerBuild.mutationOptions({
      onSuccess: () => {
        toast.success('Build started');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const total = repos.length;
  const autodeploying = repos.filter((r) => r.autodeploy).length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Repositories</CardTitle>
        <CardDescription>Watched git repos. Build a ref by hand or let autodeploy redeploy on build.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {total === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<GitBranchIcon />}
              title="No repos linked yet"
              description="Link one to build and deploy straight from a git push — no external CI."
              action={<AddRepoDialog onDone={onChanged} />}
            />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={total} /> watched
              </span>
              <span className="text-muted-foreground mono-label">{autodeploying} autodeploy</span>
            </div>
            <div className="divide-border divide-y border-t">
              {repos.map((r) => (
                <div key={r.id} className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors">
                  <GitBranchIcon className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="mono-data truncate font-medium">{r.url}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      {r.provider} · {r.branch}
                      {r.autodeploy ? ' · autodeploy' : ''}
                      {r.hasToken ? ' · token' : ''}
                    </p>
                  </div>
                  {r.autodeploy ? (
                    <Badge variant="muted" className="hidden md:inline-flex">
                      autodeploy
                    </Badge>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => triggerBuild.mutate({ repoId: r.id })}
                    disabled={triggerBuild.isPending}
                  >
                    <HammerIcon className="size-4" /> Build
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${r.url}`}
                    onClick={() => removeRepo.mutate({ id: r.id })}
                    disabled={removeRepo.isPending}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
