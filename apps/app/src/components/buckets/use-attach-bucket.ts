import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { attachedToast } from './attach-plan';

/**
 * Attach one bucket to some of an app's services (`buckets.attachToService`
 * each: a key, the S3_* variables and a secret file, one restart), then a
 * toast whose Undo detaches exactly those services again (`buckets.detach`).
 */
export function useAttachBucket(): {
  attach: (input: { bucketId: string; bucket: string; app: string; services: Array<{ id: string; name: string }> }) => Promise<boolean>;
  pending: boolean;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const attachOne = useMutation(trpc.buckets.attachToService.mutationOptions());
  const detachOne = useMutation(trpc.buckets.detach.mutationOptions());
  const refresh = React.useCallback(() => void qc.invalidateQueries(), [qc]);

  const undo = React.useCallback(
    async (bucket: string, app: string, done: string[]) => {
      try {
        for (const appService of done) await detachOne.mutateAsync({ appService });
        toast.success(`${bucket} detached from ${app} · its variables are gone`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        refresh();
      }
    },
    [detachOne, refresh],
  );

  const attach = React.useCallback(
    async ({ bucketId, bucket, app, services }: { bucketId: string; bucket: string; app: string; services: Array<{ id: string; name: string }> }) => {
      const done: string[] = [];
      let failed: string | null = null;
      for (const s of services) {
        try {
          done.push((await attachOne.mutateAsync({ bucketId, appService: s.id })).appService);
        } catch (e) {
          failed = `${s.name}: ${e instanceof Error ? e.message : String(e)}`;
          break;
        }
      }
      refresh();
      const action = done.length ? { action: { label: 'Undo', onClick: () => void undo(bucket, app, done) }, duration: 12_000 } : undefined;
      if (failed) toast.error(`Attached to ${done.length} of ${services.length} services. ${failed}`, action);
      else toast.success(attachedToast(bucket, app, done.length), action);
      return failed === null;
    },
    [attachOne, refresh, undo],
  );

  return { attach, pending: attachOne.isPending };
}
