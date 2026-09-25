import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, BugIcon } from 'lucide-react';
import { EmptyState, Skeleton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { IssueStatus } from './errors-shared';
import { IssueAside } from './issue-aside';
import { IssueEventCards } from './issue-event-cards';
import { IssueHeader } from './issue-header';

interface IssueDetailProps {
  stack: string;
  fingerprint: string;
}

/**
 * One issue: what broke (title, where, how often, how many people), what to
 * do about it (resolve / resolve in next release / ignore / reopen), and
 * everything linked to it — the stack trace with source-mapped frames, the
 * trace it happened in, the replay (when recorded), and the release that
 * introduced it.
 */
export function IssueDetail({ stack, fingerprint }: IssueDetailProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [eventId, setEventId] = React.useState<string | undefined>(undefined);
  const detail = useQuery(trpc.errors.issue.queryOptions({ stack, fingerprint, eventId }));
  const d = detail.data;
  const setStatus = useMutation(
    trpc.errors.setIssueStatus.mutationOptions({
      onSuccess: (_r, v) => {
        toast.success(
          v.status === 'resolved'
            ? 'Resolved — it reopens if it happens again'
            : v.status === 'resolved_next_release'
              ? 'Resolves with the next release — errors from a newer release reopen it'
              : v.status === 'ignored'
                ? 'Ignored — no more alerts for this one'
                : 'Reopened',
        );
        void qc.invalidateQueries({ queryKey: trpc.errors.issue.queryKey({ stack, fingerprint }) });
        void qc.invalidateQueries({ queryKey: trpc.errors.issues.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const back = (
    <Link to="/stacks/$name/errors" params={{ name: stack }} className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-fit items-center gap-1 text-sm">
      <ArrowLeftIcon className="size-3.5" /> All issues
    </Link>
  );

  if (detail.isLoading) {
    return (
      <div className="space-y-3 pb-8">
        {back}
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }
  if (!d?.issue) {
    return (
      <div className="pb-8">
        {back}
        <EmptyState icon={<BugIcon />} title={d?.status === 'disabled' ? 'The observability store is off' : 'Issue not found'} description="It may have aged out of retention." />
      </div>
    );
  }

  const issue = d.issue;
  const ev = d.event;
  const act = (status: IssueStatus) => setStatus.mutate({ stack, fingerprint, status });
  const open = issue.status === 'unresolved';

  return (
    <div className="flex flex-col gap-5 pb-8">
      {back}
      <IssueHeader stack={stack} issue={issue} busy={setStatus.isPending} act={act} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <IssueEventCards d={d} ev={ev} onPick={setEventId} />
        </div>
        <div className="space-y-4">
          <IssueAside stack={stack} d={d} ev={ev} />
        </div>
      </div>
    </div>
  );
}
