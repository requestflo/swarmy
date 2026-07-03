import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BucketQuotaView } from '@swarmy/core';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { bytesToGb, gbToBytes } from './format';

/** Always-visible quota fields — blank means unlimited, Save only enables on change. */
export function BucketQuotaField({
  bucketId,
  quotas,
}: {
  bucketId: string;
  quotas: BucketQuotaView;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const initialSize = quotas.maxSizeBytes !== null ? String(bytesToGb(quotas.maxSizeBytes)) : '';
  const initialObjects = quotas.maxObjects !== null ? String(quotas.maxObjects) : '';
  const [sizeGb, setSizeGb] = React.useState(initialSize);
  const [objects, setObjects] = React.useState(initialObjects);

  const save = useMutation(
    trpc.buckets.setQuota.mutationOptions({
      onSuccess: () => {
        toast.success('Quota updated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const sizeNum = sizeGb.trim() === '' ? null : Number(sizeGb);
  const objNum = objects.trim() === '' ? null : Number(objects);
  const valid =
    (sizeNum === null || (Number.isFinite(sizeNum) && sizeNum > 0)) &&
    (objNum === null || (Number.isInteger(objNum) && objNum > 0));
  const dirty = sizeGb !== initialSize || objects !== initialObjects;

  return (
    <div className="space-y-2">
      <p className="mono-label text-muted-foreground">Quota</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label className="mono-label">Max size (GB)</Label>
          <Input
            value={sizeGb}
            onChange={(e) => setSizeGb(e.target.value)}
            placeholder="unlimited"
            inputMode="decimal"
            className="mono-data"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Max objects</Label>
          <Input
            value={objects}
            onChange={(e) => setObjects(e.target.value)}
            placeholder="unlimited"
            inputMode="numeric"
            className="mono-data"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={save.isPending || !valid || !dirty}
          onClick={() =>
            save.mutate({
              bucketId,
              maxSizeBytes: sizeNum === null ? null : gbToBytes(sizeNum),
              maxObjects: objNum,
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save quota'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Leave a field blank for no limit. Uploads past a quota are refused by the store.
      </p>
    </div>
  );
}
