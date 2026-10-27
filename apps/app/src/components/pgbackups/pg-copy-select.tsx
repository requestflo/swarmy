import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { SecondaryTargetPicker } from '@/components/backups/schedule-secondary-select';
import { useTRPC } from '@/integrations/trpc';

interface PgCopySelectProps {
  stack: string;
  cluster: string;
  /** The schedule's main destination (not offered). */
  primaryId: string | null;
  value: string | null;
  /** wal-g copies into S3 buckets only. */
  s3Only?: boolean;
}

/** "Also copy to" on a database's schedule: every save is copied to a second destination too (`dbBackups.setSecondary`). */
export function PgCopySelect({ stack, cluster, primaryId, value, s3Only }: PgCopySelectProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const set = useMutation(
    trpc.dbBackups.setSecondary.mutationOptions({
      onSuccess: (r) => toast.success(r.secondaryTargetId ? `Every save of ${cluster} is now copied there too` : 'Second copy turned off'),
      onSettled: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const options = (targets.data ?? []).filter((t) => t.enabled && (!s3Only || t.kind.toLowerCase() === 's3')).map((t) => ({ id: t.id, name: t.name }));
  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-muted-foreground text-[12px] font-semibold">Also copy to</span>
      <div className="w-full max-w-56">
        <SecondaryTargetPicker
          targets={options}
          primaryId={primaryId ?? ''}
          value={value}
          disabled={set.isPending || targets.isPending}
          onChange={(id) => set.mutate({ stack, cluster, secondaryTargetId: id })}
        />
      </div>
    </div>
  );
}
