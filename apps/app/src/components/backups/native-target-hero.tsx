import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon, DatabaseZapIcon, XIcon } from 'lucide-react';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { NATIVE_TARGET_NAME } from './native-target-name';

interface NativeTargetHeroProps {
  targets: { id: string; name: string; bucket: string }[];
}

/**
 * One-click DR home: mints a dedicated Garage bucket + key on the in-swarm
 * replicated store and wires restic to it. The minted bucket is announced in a
 * dismissible coral banner — never a modal.
 */
export function NativeTargetHero({ targets }: NativeTargetHeroProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const storage = useQuery(trpc.storage.getConfig.queryOptions());
  const [minted, setMinted] = React.useState<string | null>(null);

  const native = targets.find((t) => t.name === NATIVE_TARGET_NAME);
  const storeOn = Boolean(storage.data?.enabled);

  const ensure = useMutation(
    trpc.backups.ensureNativeTarget.mutationOptions({
      onSuccess: (r) => {
        if (r.created) setMinted(r.bucket);
        else toast.success(`Already connected — bucket ${r.bucket}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="space-y-4">
      {minted ? (
        <div className="border-primary/40 bg-primary/10 flex items-start gap-3 rounded-2xl border px-5 py-4">
          <CheckCircle2Icon className="text-primary mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">Native destination ready.</p>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Minted bucket <code className="mono-data text-foreground">{minted}</code> with a
              dedicated key on <code className="mono-data text-foreground">swarmy-garage</code> —
              schedules can point here now.
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => setMinted(null)}>
            <XIcon className="size-4" />
          </Button>
        </div>
      ) : null}

      <div className="ink-block flex flex-wrap items-center justify-between gap-6 rounded-2xl px-6 py-6 sm:px-8">
        <div className="flex min-w-0 items-start gap-4">
          <span className="bg-ink-foreground/10 flex size-11 shrink-0 items-center justify-center rounded-2xl">
            <DatabaseZapIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-xl font-bold">Use swarmy object storage.</h2>
            <p className="text-ink-foreground/70 mt-1 max-w-xl text-sm">
              One click mints a dedicated bucket + key on your replicated Garage store and points
              restic at it over the cluster network. No cloud account, no egress.
            </p>
            {!storeOn && !native ? (
              <p className="text-ink-foreground/60 mono-label mt-2">
                Needs the replicated store — enable it below first.
              </p>
            ) : null}
          </div>
        </div>
        {native ? (
          <div className="flex items-center gap-3">
            <StatusBadge tone="online" label="connected" />
            <span className="mono-data text-sm">{native.bucket}</span>
          </div>
        ) : (
          <Button
            className="rounded-full font-bold shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]"
            disabled={ensure.isPending || !storeOn}
            onClick={() => ensure.mutate()}
          >
            {ensure.isPending ? 'Minting bucket…' : 'Use swarmy object storage'}
          </Button>
        )}
      </div>
    </div>
  );
}
