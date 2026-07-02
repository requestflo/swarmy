import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldPlusIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

/** Grant an existing access key read/write/owner on this bucket. */
export function GrantKeyDialog({ bucketId }: { bucketId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [keyId, setKeyId] = React.useState('');
  const [read, setRead] = React.useState(true);
  const [write, setWrite] = React.useState(false);
  const [owner, setOwner] = React.useState(false);

  const keys = useQuery({ ...trpc.buckets.listKeys.queryOptions(), enabled: open });
  const grant = useMutation(
    trpc.buckets.grantKeyOnBucket.mutationOptions({
      onSuccess: () => {
        toast.success('Access granted');
        setOpen(false);
        setKeyId('');
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldPlusIcon className="size-4" /> Grant key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant a key on this bucket</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
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
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              grant.mutate({
                bucketId,
                accessKeyId: keyId,
                permissions: { read, write, owner },
                mode: 'allow',
              })
            }
            disabled={grant.isPending || !keyId || (!read && !write && !owner)}
          >
            {grant.isPending ? 'Granting…' : 'Grant access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
