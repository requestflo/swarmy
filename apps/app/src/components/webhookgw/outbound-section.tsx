import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, SendIcon, Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Collapsible,
  CollapsibleContent,
  EmptyState,
  Switch,
  toast,
} from '@swarmy/ui';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { RegisterOutboundInline } from './register-outbound-inline';

/**
 * Outbound webhooks: swarmy's own events pushed to YOUR endpoints (org-wide —
 * the outbound gateway isn't stack-scoped). Register inline; delivery is
 * signed per-endpoint (X-Swarmy-Signature).
 */
export function OutboundSection(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [creating, setCreating] = React.useState(false);
  const endpoints = useQuery({ ...trpc.webhooksOut.list.queryOptions(), refetchInterval: 10_000 });

  const invalidate = (): void => void qc.invalidateQueries();
  const setActive = useMutation(
    trpc.webhooksOut.setActive.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const remove = useMutation(
    trpc.webhooksOut.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Endpoint removed');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const test = useMutation(
    trpc.webhooksOut.test.mutationOptions({
      onSuccess: (r) => toast.success(`Test ping queued to ${r.enqueued} endpoint${r.enqueued === 1 ? '' : 's'}`),
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = endpoints.data ?? [];

  return (
    <Section
      title="Webhooks out"
      count={endpoints.data ? rows.length : undefined}
      hint="swarmy's own events, sent to your URLs (all apps)"
      action={
        <>
          <Button variant="ghost" size="sm" disabled={rows.length === 0 || test.isPending} onClick={() => test.mutate({})}>
            <SendIcon className="size-3.5" /> Test ping
          </Button>
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setCreating((v) => !v)}>
            <PlusIcon className="size-3.5" /> Add an endpoint
          </Button>
        </>
      }
    >
        <Collapsible open={creating} onOpenChange={setCreating}>
          <CollapsibleContent>
            <div className="border-border mb-3 rounded-xl border p-4">
              <RegisterOutboundInline onDone={() => setCreating(false)} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {endpoints.isLoading ? (
          <div className="shimmer-line h-12 rounded-lg" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No outbound endpoints yet"
            description="Register a URL and pick the events to receive — swarmy signs every delivery so your receiver can verify it."
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="mono-data text-sm">{e.url}</p>
                  <p className="text-muted-foreground text-xs">
                    {e.events.join(', ')} · added {relTime(e.createdAt)}
                  </p>
                </div>
                <Switch
                  aria-label={`Send events to ${e.url}`}
                  checked={e.active}
                  disabled={setActive.isPending}
                  onCheckedChange={(active) => setActive.mutate({ id: e.id, active })}
                />
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Remove ${e.url}`} className="text-muted-foreground hover:text-tone-bad">
                      <Trash2Icon className="size-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this endpoint?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Deliveries to {e.url} stop immediately. This can&apos;t be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate({ id: e.id })}>
                        {remove.isPending ? 'Removing…' : 'Remove endpoint'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
    </Section>
  );
}
