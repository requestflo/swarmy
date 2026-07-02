import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** How long audit rows live before the hourly retention worker prunes them. */
export function RetentionCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const retention = useQuery(trpc.audit.retention.queryOptions());
  const [draft, setDraft] = React.useState<string | null>(null);

  const save = useMutation(
    trpc.audit.setRetention.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Audit entries now kept for ${r.days} days`);
        setDraft(null);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const current = retention.data?.days ?? 365;
  const value = draft ?? String(current);
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 7 && parsed <= 3650;
  const dirty = draft !== null && parsed !== current;

  return (
    <div className="card-pop p-5">
      <h3 className="font-display text-base font-bold">Retention</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        Entries older than this are pruned automatically. Compliance regimes usually want
        1–7 years.
      </p>
      {retention.isLoading ? (
        <div className="shimmer-line mt-4 h-9 rounded-lg" />
      ) : (
        <form
          className="mt-4 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && dirty) save.mutate({ days: parsed });
          }}
        >
          <Input
            type="number"
            min={7}
            max={3650}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            className="mono-data w-28"
            aria-label="Retention days"
          />
          <span className="text-muted-foreground text-sm">days</span>
          <Button type="submit" size="sm" variant="outline" disabled={!valid || !dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      )}
      {!valid ? (
        <p className="text-status-warning mt-2 text-xs">Pick between 7 and 3650 days.</p>
      ) : retention.data?.isDefault ? (
        <p className="text-muted-foreground mt-2 text-xs">Using the default — 365 days.</p>
      ) : null}
    </div>
  );
}
