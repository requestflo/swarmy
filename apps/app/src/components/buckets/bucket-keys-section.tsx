import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldOffIcon } from 'lucide-react';
import type { BucketDetailView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { GrantKeyDialog } from './grant-key-dialog';

/** Keys granted on this bucket, with per-flag chips and a revoke action. */
export function BucketKeysSection({ bucket }: { bucket: BucketDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const revoke = useMutation(
    trpc.buckets.grantKeyOnBucket.mutationOptions({
      onSuccess: () => {
        toast.success('Access revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="mono-label text-muted-foreground !mb-0">Keys with access</p>
        <GrantKeyDialog bucketId={bucket.id} />
      </div>
      {bucket.keys.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No keys can reach this bucket yet. Grant one to give a tool or app access.
        </p>
      ) : (
        <div className="border-border divide-border divide-y rounded-lg border">
          {bucket.keys.map((k) => (
            <div key={k.accessKeyId} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{k.name || k.accessKeyId}</p>
                <p className="mono-data text-muted-foreground truncate text-xs">{k.accessKeyId}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="mono-data text-muted-foreground text-xs">
                  {[
                    k.permissions.read ? 'read' : null,
                    k.permissions.write ? 'write' : null,
                    k.permissions.owner ? 'owner' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'no access'}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Revoke ${k.name || k.accessKeyId}`}
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate({
                      bucketId: bucket.id,
                      accessKeyId: k.accessKeyId,
                      permissions: { read: true, write: true, owner: true },
                      mode: 'deny',
                    })
                  }
                >
                  <ShieldOffIcon className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
