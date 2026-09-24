import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  CopyButton,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const NONE = '__none__';

/**
 * "Add queue": provision a BullMQ-ready managed Valkey (noeviction, AOF,
 * backed up) and optionally wire an app service to it as QUEUE_URL. The
 * password is shown once, here, and never again.
 */
export function AddQueueInline({ stack, onDone }: { stack: string; onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('jobs');
  const [memoryMb, setMemoryMb] = React.useState(256);
  const [attach, setAttach] = React.useState(NONE);
  const [secret, setSecret] = React.useState<{ host: string; password: string } | null>(null);

  const services = useQuery(trpc.services.list.queryOptions({}));
  const candidates = (services.data ?? []).filter(
    (s) => s.name.startsWith(`${stack}_`) && !s.name.includes('-cache'),
  );

  const provision = useMutation(
    trpc.cache.provision.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Queue ${r.cluster} is provisioning`);
        setSecret({ host: r.host, password: r.password });
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const valid = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(name);

  if (secret) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold">
          It’s coming up. Copy the password now — swarmy won’t show it again.
        </p>
        <div className="flex items-center gap-2">
          <code className="bg-muted/40 mono-data flex-1 truncate rounded-md px-3 py-2 text-xs">{secret.password}</code>
          <CopyButton value={secret.password} />
        </div>
        <p className="text-muted-foreground text-xs">
          Apps on the queue network reach it at <span className="mono-data">redis://{secret.host}:6379</span>. An
          attached service gets <span className="mono-data">QUEUE_URL</span> and{' '}
          <span className="mono-data">QUEUE_PASSWORD_FILE</span>.
        </p>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        A managed Valkey tuned for BullMQ: it never evicts a job, keeps an append-only log, and is backed up nightly
        with the rest of your data. Private to the swarm.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="queue-name">Name</Label>
          <Input id="queue-name" value={name} onChange={(e) => setName(e.target.value.trim())} className="mono-data" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="queue-mem">Memory (MB)</Label>
          <Input
            id="queue-mem"
            type="number"
            min={64}
            max={65536}
            value={memoryMb}
            onChange={(e) => setMemoryMb(Math.max(64, Number(e.target.value) || 256))}
          />
        </div>
        <div className="space-y-1">
          <Label>Wire to service</Label>
          <Select value={attach} onValueChange={setAttach}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not now</SelectItem>
              {candidates.map((s) => (
                <SelectItem key={s.name} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!valid || provision.isPending}
          onClick={() =>
            provision.mutate({
              stack,
              name,
              engine: 'valkey',
              topology: 'single',
              memoryMb,
              replicas: 0,
              regions: [],
              purpose: 'queue',
              ...(attach !== NONE ? { attachService: attach } : {}),
            })
          }
        >
          {provision.isPending ? 'Adding…' : 'Add queue'}
        </Button>
      </div>
    </div>
  );
}
