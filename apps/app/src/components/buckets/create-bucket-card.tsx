import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

interface CreateBucketCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline create card (no modal): name only — private by default. */
export function CreateBucketCard({ open, onOpenChange }: CreateBucketCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');

  const create = useMutation(
    trpc.buckets.createBucket.mutationOptions({
      onSuccess: (b) => {
        toast.success(`Bucket "${b.name}" created`);
        setName('');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const valid = NAME_RE.test(name);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">New bucket</p>
            <p className="text-muted-foreground text-xs">
              Private by default — apps get access via scoped keys.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Bucket name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="app-uploads"
              className="mono-data"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              3–63 chars: lowercase letters, digits, dots, dashes.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate({ name })} disabled={create.isPending || !valid}>
              {create.isPending ? 'Creating…' : 'Create bucket'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
