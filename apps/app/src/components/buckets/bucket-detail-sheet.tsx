import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import {
  Button,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { BucketAttachSection } from './bucket-attach-section';
import { BucketKeysSection } from './bucket-keys-section';
import { BucketQuotaDialog } from './bucket-quota-dialog';
import { fmtBytes, fmtCount } from './format';

interface BucketDetailSheetProps {
  bucketId: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Slide-over: usage, quota editor, website toggle, key grants, app attachment, delete. */
export function BucketDetailSheet({ bucketId, onOpenChange }: BucketDetailSheetProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const detail = useQuery({
    ...trpc.buckets.get.queryOptions({ bucketId: bucketId ?? '' }),
    enabled: bucketId !== null,
    refetchInterval: 15_000,
  });

  const setWebsite = useMutation(
    trpc.buckets.setWebsite.mutationOptions({
      onSuccess: (b) => {
        toast[b.website ? 'warning' : 'success'](
          b.website ? `"${b.name}" is now PUBLIC — anyone can read it over HTTP` : `"${b.name}" is private again`,
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.buckets.deleteBucket.mutationOptions({
      onSuccess: () => {
        toast.success('Bucket deleted');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const b = detail.data;

  return (
    <Sheet open={bucketId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-lg">
        {detail.isLoading || !b ? (
          <div className="space-y-3 pt-8">
            <div className="shimmer-line h-8 rounded-lg" />
            <div className="shimmer-line h-24 rounded-lg" />
            <div className="shimmer-line h-24 rounded-lg" />
          </div>
        ) : (
          <>
            <SheetHeader className="p-0">
              <SheetTitle className="mono-data text-xl">{b.name}</SheetTitle>
            </SheetHeader>

            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Stored', value: fmtBytes(b.usageBytes) },
                { label: 'Objects', value: fmtCount(b.objects) },
                { label: 'In-flight uploads', value: fmtCount(b.unfinishedUploads) },
              ].map((s) => (
                <div key={s.label} className="bg-accent/50 rounded-xl p-3">
                  <p className="mono-data text-lg font-semibold">{s.value}</p>
                  <p className="text-muted-foreground text-xs">{s.label}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Quota</p>
                <p className="text-muted-foreground text-xs">
                  {b.quotas.maxSizeBytes !== null ? fmtBytes(b.quotas.maxSizeBytes) : 'unlimited size'}
                  {' · '}
                  {b.quotas.maxObjects !== null ? `${fmtCount(b.quotas.maxObjects)} objects` : 'unlimited objects'}
                </p>
              </div>
              <BucketQuotaDialog bucketId={b.id} quotas={b.quotas} />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Public website</p>
                <p className="text-muted-foreground text-xs">
                  Serves objects to anyone over HTTP. Off by default — leave off for app data.
                </p>
              </div>
              <Switch
                checked={b.website}
                disabled={setWebsite.isPending}
                onCheckedChange={(enabled) => setWebsite.mutate({ bucketId: b.id, enabled })}
                aria-label="Public website"
              />
            </div>

            <Separator />
            <BucketKeysSection bucket={b} />
            <Separator />
            <BucketAttachSection bucket={b} />
            <Separator />

            <div className="flex items-center justify-between gap-3 pb-2">
              <p className="text-muted-foreground text-xs">
                Delete is refused while the bucket holds objects or is attached to an app.
              </p>
              <Button
                variant="outline"
                className="text-status-offline shrink-0"
                disabled={del.isPending}
                onClick={() => {
                  if (window.confirm(`Delete bucket "${b.name}"?`)) del.mutate({ bucketId: b.id });
                }}
              >
                <Trash2Icon className="size-4" /> Delete bucket
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
