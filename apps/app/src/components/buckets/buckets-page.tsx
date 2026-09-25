import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArchiveIcon, PlusIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, CodeView, Depth, Say, Tech } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { BucketsTable } from './buckets-table';
import { CreateBucketCard } from './create-bucket-card';
import { EngineUpgradeCard } from './engine-upgrade-card';
import { fmtBytes } from './format';
import { KeysCard } from './keys-card';
import { StoreDisabledCard } from './store-disabled-card';

/** Data → Files & buckets: S3 buckets on your own servers — what each holds, who reaches it, how many copies. */
export function BucketsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const overview = useQuery({ ...trpc.buckets.overview.queryOptions(), refetchInterval: 20_000 });
  const storage = useQuery(trpc.storage.getConfig.queryOptions());
  if (overview.isPending) return <PageSkeleton variant="list" />;

  const o = overview.data;
  const buckets = o?.buckets ?? [];
  const total = buckets.reduce((sum, b) => sum + b.usageBytes, 0);
  const ready = o?.state === 'ready';
  const copies = storage.data?.replicationFactor ?? 1;
  const open = buckets.filter((b) => b.website).length;
  const title =
    ready && buckets.length > 0 ? (
      <>
        {fmtBytes(total)} in {buckets.length} bucket{buckets.length === 1 ? '' : 's'}.{' '}
        {open ? <Say tone="warn">{open} open to the internet.</Say> : <em>Each file kept on {copies} servers.</em>}
      </>
    ) : ready ? (
      <>No buckets yet. <em>Files your apps upload live here.</em></>
    ) : (
      <>File storage is off. <em>Turn it on to keep files on your servers.</em></>
    );
  const yaml = buckets.map((b) => `  ${b.name}:\n    type: bucket`).join('\n');

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        title={title}
        description="S3-compatible storage on your own servers. Private by default; an app gets its own key when you attach it."
        actions={ready ? <Button onClick={() => setCreateOpen((v) => !v)}><PlusIcon className="size-4" /> New bucket</Button> : undefined}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {ready ? <EngineUpgradeCard /> : null}
          {ready ? <CreateBucketCard open={createOpen} onOpenChange={setCreateOpen} /> : null}
          {overview.isError ? (
            <div className="calm-card p-2">
              <EmptyState icon={<ArchiveIcon />} title="Couldn't load buckets" description={overview.error.message} action={<Button variant="outline" onClick={() => void overview.refetch()}>Retry</Button>} />
            </div>
          ) : o?.state === 'disabled' ? (
            <StoreDisabledCard />
          ) : o?.state === 'unreachable' ? (
            <div className="calm-card p-2">
              <EmptyState icon={<ArchiveIcon />} title="File storage isn't answering" description={o.message ?? 'The store did not answer. Check its servers on the Backups page.'} action={<Button variant="outline" onClick={() => void overview.refetch()}>Retry</Button>} />
            </div>
          ) : buckets.length === 0 ? (
            <div className="calm-card p-2">
              <EmptyState icon={<ArchiveIcon />} title="No buckets yet" description="Buckets hold uploads, assets and exports. Create one, then attach it to an app." />
            </div>
          ) : (
            <BucketsTable buckets={buckets} expandedId={expandedId} onToggle={(id) => setExpandedId((c) => (c === id ? null : id))} />
          )}
          {o?.endpoint ? <Tech>S3 endpoint {o.endpoint} · region {o.region}</Tech> : null}
          {ready ? <Depth at="controls"><KeysCard /></Depth> : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <CodeView tabs={[{ label: 'swarmy.yaml', code: `# in each app's swarmy.yaml\nresources:\n${yaml || '  # no buckets yet'}` }]} source="yaml" />
          {ready ? (
            <AlreadyOn
              items={[
                { what: 'Copies', detail: `each file kept on ${copies} server${copies === 1 ? '' : 's'}` },
                { what: 'Private', detail: 'nothing is reachable without a key' },
                { what: 'Destinations', detail: 'a bucket can hold your backups', to: '/backups' },
              ]}
            />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
