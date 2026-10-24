import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HistoryIcon, Loader2Icon, RotateCwIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * The app header's two quiet actions: Rewind (the Time travel page) and
 * Redeploy (`stacks.redeploy`: the stored compose again, one copy at a time).
 * Never coral: the page's one coral action belongs to what needs you.
 * Redeploy shows only when there is a stored compose to send.
 */
export function AppHeaderActions({ stack, stackId }: { stack: string; stackId: string | null }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const redeploy = useMutation(
    trpc.stacks.redeploy.mutationOptions({
      onSuccess: () => {
        toast.success(`Redeploying ${stack}, one copy at a time.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <>
      <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
        <Link to="/stacks/$name/time-travel" params={{ name: stack }}>
          <HistoryIcon aria-hidden /> Rewind
        </Link>
      </Button>
      {stackId ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={redeploy.isPending}
          onClick={() => redeploy.mutate({ id: stackId })}
        >
          {redeploy.isPending ? <Loader2Icon aria-hidden className="animate-spin" /> : <RotateCwIcon aria-hidden />}
          Redeploy
        </Button>
      ) : null}
    </>
  );
}
