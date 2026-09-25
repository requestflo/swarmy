import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** The per-app ingest cap: events past it get a 429 with Retry-After. */
export function RateLimitInput({ stack, perMinute }: { stack: string; perMinute: number }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(String(perMinute));
  React.useEffect(() => setDraft(String(perMinute)), [perMinute]);
  const save = useMutation(
    trpc.errors.setRateLimit.mutationOptions({
      onSuccess: (p) => {
        toast.success(`Capped at ${p.rateLimitPerMinute} events/min`);
        void qc.invalidateQueries({ queryKey: trpc.errors.status.queryKey({ stack }) });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <form
      className="inline-flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && n !== perMinute) save.mutate({ stack, perMinute: n });
      }}
    >
      <Input
        type="number"
        min={1}
        max={100_000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Events per minute"
        className="mono-data h-7 w-20 px-2 text-xs"
      />
      {valid && n !== perMinute && (
        <Button type="submit" size="sm" variant="outline" className="h-7 px-2" disabled={save.isPending}>
          Save
        </Button>
      )}
    </form>
  );
}
