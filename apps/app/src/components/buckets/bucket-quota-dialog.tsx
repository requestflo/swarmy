import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GaugeIcon } from 'lucide-react';
import type { BucketQuotaView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { bytesToGb, gbToBytes } from './format';

/** Edit max-size (GB) / max-objects; blank = unlimited. */
export function BucketQuotaDialog({
  bucketId,
  quotas,
}: {
  bucketId: string;
  quotas: BucketQuotaView;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [sizeGb, setSizeGb] = React.useState('');
  const [objects, setObjects] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setSizeGb(quotas.maxSizeBytes !== null ? String(bytesToGb(quotas.maxSizeBytes)) : '');
      setObjects(quotas.maxObjects !== null ? String(quotas.maxObjects) : '');
    }
  }, [open, quotas.maxSizeBytes, quotas.maxObjects]);

  const save = useMutation(
    trpc.buckets.setQuota.mutationOptions({
      onSuccess: () => {
        toast.success('Quota updated');
        setOpen(false);
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <GaugeIcon className="size-4" /> Edit quota
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bucket quota</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Max size (GB)</Label>
            <Input
              value={sizeGb}
              onChange={(e) => setSizeGb(e.target.value)}
              placeholder="unlimited"
              inputMode="decimal"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Max objects</Label>
            <Input
              value={objects}
              onChange={(e) => setObjects(e.target.value)}
              placeholder="unlimited"
              inputMode="numeric"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Leave a field blank for no limit. Uploads past a quota are refused by the store.
          </p>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              save.mutate({
                bucketId,
                maxSizeBytes: sizeNum === null ? null : gbToBytes(sizeNum),
                maxObjects: objNum,
              })
            }
            disabled={save.isPending || !valid}
          >
            {save.isPending ? 'Saving…' : 'Save quota'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
