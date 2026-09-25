import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Depth, SayHeader } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ErrorsCode } from './errors-code';
import { ErrorsSetupCard } from './errors-setup-card';
import { ErrorsNextAction, ErrorsSummaryList, errorsHeadline, worstIssue, type IssueLite } from './errors-summary';
import { IssuesList } from './issues-list';

/**
 * The app's Errors tab (Errors board). Summary: how many open errors and
 * what's new, the worst one as the next action, the open list in plain words.
 * Controls: the DSN/opt-in card and the filterable issues list. Code: the
 * SENTRY_* env, `swarmy errors dsn` / `sourcemaps upload`, REST.
 */
export function StackErrorsTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.errors.status.queryOptions({ stack }), refetchInterval: 10_000 });
  const issues = useQuery({ ...trpc.errors.issues.queryOptions({ stack, status: 'unresolved', limit: 100 }), refetchInterval: 15_000 });
  if (status.isPending || issues.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;

  const enabled = !!status.data?.enabled;
  const rows = (issues.data?.issues ?? []) as IssueLite[];
  const head = enabled
    ? errorsHeadline(stack, rows)
    : { title: <>Error tracking is off for {stack}.</>, lede: 'Turn it on and any Sentry SDK in the app reports here, grouped, with the release that brought each error.' };

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SayHeader size="md" title={head.title} lede={head.lede} />
      <ErrorsCode stack={stack} enabled={enabled} dsn={status.data?.project?.dsn ?? null} />
      <ErrorsNextAction stack={stack} enabled={enabled} worst={worstIssue(rows)} />
      <Depth only="summary">
        <ErrorsSummaryList stack={stack} issues={rows} />
      </Depth>
      <Depth at="controls">
        <ErrorsSetupCard stack={stack} />
        <IssuesList stack={stack} />
      </Depth>
    </div>
  );
}
