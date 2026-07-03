import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface GrantKeyInlineProps {
  bucketId: string;
  open: boolean;
  onDone: () => void;
}

/** Inline grant (expands under the "Grant key" button, no modal): pick a key, flip flags. */
export function GrantKeyInline({ bucketId, open, onDone }: GrantKeyInlineProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [keyId, setKeyId] = React.useState('');
  const [read, setRead] = React.useState(true);
  const [write, setWrite] = React.useState(false);
  const [owner, setOwner] = React.useState(false);

  const keys = useQuery({ ...trpc.buckets.listKeys.queryOptions(), enabled: open });
  const grant = useMutation(
    trpc.buckets.grantKeyOnBucket.mutationOptions({
      onSuccess: () => {
        toast.success('Access granted');
        setKeyId('');
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const flags: Array<{ label: string; hint: string; value: boolean; set: (v: boolean) => void }> = [
    { label: 'Read', hint: 'download & list objects', value: read, set: setRead },
    { label: 'Write', hint: 'upload & delete objects', value: write, set: setWrite },
    { label: 'Owner', hint: 'change bucket settings', value: owner, set: setOwner },
  ];

  return (
    <Collapsible open={open}>
      <CollapsibleContent>
        <div className="border-border bg-card space-y-3 rounded-xl border p-4">
          <div className="grid gap-1.5">
            <Label className="mono-label">Access key</Label>
            <Select value={keyId} onValueChange={setKeyId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a key…" />
              </SelectTrigger>
              <SelectContent>
                {(keys.data?.keys ?? []).map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.name || k.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {flags.map((f) => (
            <div key={f.label} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{f.label}</p>
                <p className="text-muted-foreground text-xs">{f.hint}</p>
              </div>
              <Switch checked={f.value} onCheckedChange={f.set} aria-label={f.label} />
            </div>
          ))}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={grant.isPending || !keyId || (!read && !write && !owner)}
              onClick={() =>
                grant.mutate({
                  bucketId,
                  accessKeyId: keyId,
                  permissions: { read, write, owner },
                  mode: 'allow',
                })
              }
            >
              {grant.isPending ? 'Granting…' : 'Grant access'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
