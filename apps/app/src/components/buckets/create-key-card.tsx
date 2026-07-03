import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { RevealedKey } from './key-reveal-banner';

interface CreateKeyCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after create so the reveal-once banner shows. */
  onCreated: (revealed: RevealedKey) => void;
}

/** Inline create card (no modal): name only — keys start with no bucket access. */
export function CreateKeyCard({ open, onOpenChange, onCreated }: CreateKeyCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');

  const create = useMutation(
    trpc.buckets.createKey.mutationOptions({
      onSuccess: (k) => {
        onCreated({ accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey });
        setName('');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="space-y-3 px-5 py-4">
          <div>
            <p className="text-sm font-bold">New access key</p>
            <p className="text-muted-foreground text-xs">
              Starts with no access — grant it per-bucket read/write/owner after creating.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Key name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-uploader"
              className="mono-data"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate({ name })}
              disabled={create.isPending || name.trim().length === 0}
            >
              {create.isPending ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
