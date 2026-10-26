import * as React from 'react';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Say } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import type { AttachTarget } from '@/components/buckets/attach-preview';
import { AddDataMenu } from './add-data-menu';
import { BucketReachPanel } from './bucket-reach-panel';
import { SHARED } from './data-board-model';
import { DataClusters } from './data-clusters';
import { EstateDataCode } from './data-code';
import { DataNextAction } from './data-next-action';
import { DataPgCopies } from './data-pg-copies';
import { storeCount } from './estate-data';
import { useDataBoard } from './use-data-board';

/**
 * Data hub (board 15): everything the apps keep, by app, with who can reach
 * each bucket. Drop a bucket on an app to attach it; drag a database's writer
 * onto a standby copy to hand it the writes.
 */
export function DataPage(): React.JSX.Element {
  const d = useDataBoard();
  const [target, setTarget] = React.useState<AttachTarget | null>(null);
  if (d.error && !d.ready) return <Pad><PageError error={d.error} retry={d.retry} /></Pad>;
  if (!d.ready) return <PageSkeleton variant="list" />;

  const managed = d.items.filter((i) => i.kind !== 'Compose');
  const needs = d.items.filter((i) => i.tone === 'warn' || i.tone === 'bad').length;
  const dbs = d.pgRows.length;
  const scheduled = d.pgRows.filter((r) => r.scheduled).length;
  const failing = d.pgRows.filter((r) => r.scheduled && r.lastStatus === 'failed').length;
  const allSaved = dbs > 0 && scheduled === dbs && failing === 0;
  const appCount = new Set(managed.map((i) => i.app).filter((a) => a !== SHARED)).size;
  const across = `${storeCount(managed)} across ${appCount} app${appCount === 1 ? '' : 's'}.`;
  const title =
    managed.length === 0 ? (
      <>No data yet. <em>Your apps keep nothing so far.</em></>
    ) : needs === 0 ? (
      <>{across} <em>Every one is safe.</em></>
    ) : (
      <>{across} <Say tone="warn">{needs} need{needs === 1 ? 's' : ''} a look.</Say></>
    );

  return (
    <Pad>
      <SectionHeader
        title={title}
        description={dbs ? `${scheduled} of ${dbs} database${dbs === 1 ? '' : 's'} saved on a schedule${failing ? `, and ${failing === 1 ? 'one' : failing} of those failed its last save` : ''}. Buckets are kept on ${d.copies} server${d.copies === 1 ? '' : 's'}.` : 'Databases, caches and buckets from every app, with how each is kept safe.'}
        actions={<AddDataMenu apps={d.apps} primary={!d.worst} />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {d.worst ? <DataNextAction worst={d.worst} /> : null}
          <DataClusters d={d} target={target} onTarget={setTarget} />
          <DataPgCopies rows={d.pgRows} />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <EstateDataCode d={d} />
          <BucketReachPanel d={d} onAttach={setTarget} />
          <AlreadyOn
            items={[
              // A partial state isn't "already on": until every database saves cleanly it's in the headline and NextAction instead.
              ...(allSaved || dbs === 0
                ? [{ what: 'Backups', detail: dbs ? `all ${dbs} databases on a schedule` : 'every new database is saved nightly', to: '/backups' as const }]
                : []),
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
