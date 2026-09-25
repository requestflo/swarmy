import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, NextAction, Say } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { useEstateData } from './use-estate-data';
import { DataGroups } from './data-groups';
import { EstateDataCode } from './data-code';

/** Data hub — its tab is "All data": everything the apps keep, and whether each is safe. */
export function DataPage(): React.JSX.Element {
  const d = useEstateData();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const run = useMutation(
    trpc.dbBackups.run.mutationOptions({
      onSuccess: () => {
        toast.success('Saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (d.error && !d.ready) return <Pad><PageError error={d.error} retry={d.retry} /></Pad>;
  if (!d.ready) return <PageSkeleton variant="list" />;

  const total = d.items.length;
  const needs = d.items.filter((i) => i.tone === 'warn' || i.tone === 'bad').length;
  const dbs = d.pgRows.length;
  const saved = d.pgRows.filter((r) => r.scheduled && r.lastStatus !== 'failed').length;
  const appCount = d.apps.filter((a) => a !== 'Shared').length;
  const title =
    total === 0 ? (
      <>No data yet. <em>Your apps keep nothing so far.</em></>
    ) : needs === 0 ? (
      <>{total} stores across {appCount} app{appCount === 1 ? '' : 's'}. <em>Every one is safe.</em></>
    ) : (
      <>{total} stores across {appCount} app{appCount === 1 ? '' : 's'}. <Say tone="warn">{needs} need{needs === 1 ? 's' : ''} a look.</Say></>
    );
  const w = d.worst;

  return (
    <Pad>
      <SectionHeader
        title={title}
        description={dbs ? `${saved} of ${dbs} database${dbs === 1 ? '' : 's'} saved on a schedule. Buckets are kept on ${d.copies} server${d.copies === 1 ? '' : 's'}.` : 'Databases, caches and buckets from every app, with how each is kept safe.'}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {w ? (
            <NextAction
              tone={w.tone}
              title={`${w.app} / ${w.name}: ${w.say.replace(/\.$/, '')}`}
              tech={w.tech}
              actions={
                w.kind === 'Postgres' && w.cluster ? (
                  <>
                    <Button disabled={run.isPending} onClick={() => run.mutate({ stack: w.app, cluster: w.cluster! })}>
                      {run.isPending ? 'Saving…' : 'Save it now'}
                    </Button>
                    <Button variant="outline" asChild>
                      <Link to="/stacks/$name/data" params={{ name: w.app }}>Set up nightly saves</Link>
                    </Button>
                  </>
                ) : (
                  <Button asChild>
                    <Link to={w.kind === 'Bucket' ? '/data/buckets' : '/stacks/$name/data'} params={w.kind === 'Bucket' ? undefined : ({ name: w.app } as never)}>
                      Open it
                    </Link>
                  </Button>
                )
              }
            >
              This is the least-protected thing you keep. A save now takes a minute and doesn’t stop the app.
            </NextAction>
          ) : null}
          <DataGroups d={d} />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <EstateDataCode d={d} />
          <AlreadyOn
            items={[
              { what: 'Backups', detail: dbs ? `${saved} of ${dbs} databases on a schedule` : 'every new database is saved nightly', to: '/backups' },
              { what: 'Volumes', detail: 'every app volume saved nightly', to: '/backups' },
              { what: 'Buckets', detail: `each file kept on ${d.copies} server${d.copies === 1 ? '' : 's'}`, to: '/data/buckets' },
            ]}
          />
        </aside>
      </div>
    </Pad>
  );
}

function Pad({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">{children}</div>;
}
