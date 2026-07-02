import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, GitPullRequestIcon, Trash2Icon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  toast,
  type StatusTone,
} from '@swarmy/ui';
import type { PreviewView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

const TONE: Record<PreviewView['status'], StatusTone> = {
  running: 'online',
  deploying: 'progress',
  degraded: 'warning',
  stopped: 'neutral',
};

function expiresLabel(p: PreviewView): string {
  if (!p.expiresAt) return 'no TTL';
  const ms = new Date(p.expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expiring now';
  const h = Math.ceil(ms / 3_600_000);
  return h >= 48 ? `expires in ${Math.round(h / 24)}d` : `expires in ${h}h`;
}

interface PreviewsListProps {
  previews: PreviewView[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/** Live preview stacks — flat rows in one card, hairline-divided. */
export function PreviewsList({ previews, isLoading, isError, onRetry }: PreviewsListProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const destroy = useMutation(
    trpc.previews.destroy.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Preview ${r.stack} torn down`);
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Active previews</CardTitle>
        <CardDescription>One row per open PR — follow the link, or kill it early.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3 py-2">
            <div className="shimmer-line h-5 w-3/4" />
            <div className="shimmer-line h-5 w-2/3" />
          </div>
        ) : isError ? (
          <EmptyState
            title="Couldn't load previews"
            description="The controller didn't answer. Give it another go."
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        ) : !previews || previews.length === 0 ? (
          <EmptyState
            icon={<GitPullRequestIcon />}
            title="No previews running"
            description="Enable previews for a repo, then open a pull request — or spin one up from a branch on the left."
          />
        ) : (
          <ul className="divide-border divide-y">
            {previews.map((p) => (
              <li key={p.stack} className="hover:bg-accent/40 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono-data font-semibold">PR #{p.pr}</span>
                    <span className="text-muted-foreground truncate text-sm">{p.repo} · {p.branch}</span>
                    <StatusBadge tone={TONE[p.status]} label={p.status} />
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 text-xs">
                    <span className="mono-label normal-case">{p.stack}</span>
                    <span>deployed {relTime(p.createdAt)}</span>
                    <span>{expiresLabel(p)}</span>
                    <span>
                      {p.runningServices}/{p.serviceCount} services up
                    </span>
                  </div>
                </div>
                {p.url ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      Open <ExternalLinkIcon className="ml-1 size-3.5" />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="text-status-offline border-status-offline/40 hover:bg-status-offline/10"
                  disabled={destroy.isPending}
                  onClick={() => destroy.mutate({ stack: p.stack })}
                >
                  <Trash2Icon className="mr-1 size-3.5" /> Destroy
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
