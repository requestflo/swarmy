import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArchiveIcon, PlusIcon } from 'lucide-react';
import { Button, CopyButton, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { BucketsTable } from './buckets-table';
import { CreateBucketCard } from './create-bucket-card';
import { fmtBytes } from './format';
import { KeysCard } from './keys-card';
import { StoreDisabledCard } from './store-disabled-card';

/**
 * Data → Buckets: S3 buckets on the managed Garage store — usage, quotas,
 * access keys, and one-click app attachment.
 */
export function BucketsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const overview = useQuery({ ...trpc.buckets.overview.queryOptions(), refetchInterval: 20_000 });

  const o = overview.data;
  const buckets = o?.buckets ?? [];
  const totalBytes = buckets.reduce((sum, b) => sum + b.usageBytes, 0);
  const ready = o?.state === 'ready';

  const toggle = (id: string): void => setExpandedId((cur) => (cur === id ? null : id));

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Platform"
        title={
          ready && buckets.length > 0 ? (
            <>
              {fmtBytes(totalBytes)} in <em>{buckets.length}</em> bucket{buckets.length === 1 ? '' : 's'}.
            </>
          ) : (
            <>
              Buckets, <em>yours</em>.
            </>
          )
        }
        description="S3-compatible object storage on your own nodes — create buckets, mint access keys and wire apps with one click."
        actions={
          ready ? (
            <Button onClick={() => setCreateOpen((o2) => !o2)}>
              <PlusIcon className="size-4" /> New bucket
            </Button>
          ) : undefined
        }
      />

      {ready ? <CreateBucketCard open={createOpen} onOpenChange={setCreateOpen} /> : null}

      {overview.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          <div className="shimmer-line h-8 rounded-lg" />
          <div className="shimmer-line h-8 rounded-lg" />
          <div className="shimmer-line h-8 w-2/3 rounded-lg" />
        </div>
      ) : overview.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ArchiveIcon />}
            title="Couldn't load buckets"
            description={overview.error.message}
            action={
              <Button variant="outline" onClick={() => void overview.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : o?.state === 'disabled' ? (
        <StoreDisabledCard />
      ) : o?.state === 'unreachable' ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ArchiveIcon />}
            title="Object store unreachable"
            description={o.message ?? 'The Garage admin API did not answer. Check the store members on the Backups page.'}
            action={
              <Button variant="outline" onClick={() => void overview.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : buckets.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ArchiveIcon />}
            title="No buckets yet — create one."
            description="Buckets hold uploads, assets and backups. Private by default; apps get scoped keys injected as env + a Docker secret."
            action={
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-4" /> New bucket
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-6">
          <BucketsTable buckets={buckets} expandedId={expandedId} onToggle={toggle} />
          {o?.endpoint ? (
            <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              S3 endpoint <code className="mono-data bg-accent rounded px-1.5 py-0.5">{o.endpoint}</code>
              region <code className="mono-data bg-accent rounded px-1.5 py-0.5">{o.region}</code>
              <CopyButton value={o.endpoint} className="size-6" />
            </p>
          ) : null}
        </div>
      )}

      {ready ? (
        <div className="mt-6">
          <KeysCard />
        </div>
      ) : null}
    </div>
  );
}
