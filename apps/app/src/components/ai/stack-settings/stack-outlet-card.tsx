import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon } from 'lucide-react';
import { Button, Input, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface StackOutletCardProps {
  stack: string;
}

/**
 * Outlet exposure: give the stack's AI gateway its own public domain. The edge
 * renders one vhost per outlet — apps outside the cluster call the domain, the
 * stack key still gates every request.
 */
export function StackOutletCard({ stack }: StackOutletCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const access = useQuery({ ...trpc.ai.stackAccess.queryOptions({ stack }), refetchInterval: 5_000 });
  const [draft, setDraft] = React.useState<string | null>(null);

  const save = useMutation(
    trpc.ai.setStackOutlet.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.domain ? `Outlet set — ${r.domain}` : 'Outlet cleared');
        setDraft(null);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const current = access.data?.outletDomain ?? null;
  const value = draft ?? current ?? '';
  const dirty = draft !== null && draft.trim().toLowerCase() !== (current ?? '');

  return (
    <section className="card-pop p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
            <GlobeIcon className="size-5" />
          </span>
          <div>
            <p className="font-semibold">AI outlet</p>
            <p className="text-muted-foreground text-xs">
              Expose this stack&apos;s gateway on its own domain.
            </p>
          </div>
        </div>
        <StatusBadge tone={current ? 'online' : 'neutral'} label={current ? 'exposed' : 'internal only'} />
      </div>

      {access.isLoading ? (
        <div className="mt-4 shimmer-line h-10 rounded-lg" />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1 basis-52"
              placeholder={`ai.${stack}.example.com`}
              value={value}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ stack, domain: value.trim() })}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {current ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate({ stack, domain: '' })}
              >
                Clear
              </Button>
            ) : null}
          </div>

          <div className="bg-muted/40 mt-3 rounded-lg px-3 py-2">
            <p className="mono-data text-xs">
              {value.trim() || `ai.${stack}.example.com`} → CNAME → your edge nodes
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Point a CNAME at your edge and swarmy answers this host with the {stack} gateway —
              requests still need the stack&apos;s virtual key.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
