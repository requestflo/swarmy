import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Separator,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { BucketAttachSection } from './bucket-attach-section';
import { BucketKeysSection } from './bucket-keys-section';
import { BucketPresignSection } from './bucket-presign-section';
import { BucketQuotaField } from './bucket-quota-field';
import { fmtBytes, fmtCount } from './format';

interface BucketDetailPanelProps {
  bucketId: string;
  onDeleted: () => void;
}

/** Row-expand content: usage, quota, website toggle, key grants, app attachment, delete. */
export function BucketDetailPanel({
  bucketId,
  onDeleted,
}: BucketDetailPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const detail = useQuery({
    ...trpc.buckets.get.queryOptions({ bucketId }),
    refetchInterval: 15_000,
  });

  const setWebsite = useMutation(
    trpc.buckets.setWebsite.mutationOptions({
      onSuccess: (b) => {
        toast[b.website ? 'warning' : 'success'](
          b.website
            ? `"${b.name}" is now PUBLIC — anyone can read it over HTTP`
            : `"${b.name}" is private again`,
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
        onDeleted();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const b = detail.data;

  if (detail.isLoading || !b) {
    return (
      <div className="space-y-3 border-t px-5 py-5">
        <div className="shimmer-line h-8 rounded-lg" />
        <div className="shimmer-line h-16 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="bg-accent/20 space-y-5 border-t px-5 py-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Stored', value: fmtBytes(b.usageBytes) },
          { label: 'Objects', value: fmtCount(b.objects) },
          { label: 'In-flight uploads', value: fmtCount(b.unfinishedUploads) },
        ].map((s) => (
          <div key={s.label} className="bg-card rounded-xl p-3">
            <p className="mono-data text-lg font-semibold">{s.value}</p>
            <p className="text-muted-foreground text-xs">{s.label}</p>
          </div>
        ))}
      </div>

      <BucketQuotaField bucketId={b.id} quotas={b.quotas} />

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
      <BucketPresignSection bucket={b} />
      <Separator />

      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Delete is refused while the bucket holds objects or is attached to an app.
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="text-status-offline shrink-0"
              disabled={del.isPending}
            >
              <Trash2Icon className="size-4" /> Delete bucket
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete bucket "{b.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                Permanently removes the bucket from the store. There is no undo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction onClick={() => del.mutate({ bucketId: b.id })}>
                Delete bucket
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
