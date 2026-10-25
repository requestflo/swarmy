import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
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
  toast,
} from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { CertFacts } from './cert-facts-model';
import { RENEW_COST, RENEW_WHAT, renewBlockedLine, renewOutcomeTone } from './renew-words';

/**
 * Renew now (board 30), at Controls: the edge re-issues this address's
 * certificate, the current one put back if no new one comes. Not the page's
 * coral action; it says what it spends before it is pressed, and when it is
 * not offered (shared store, wildcard, rate limit) it says why.
 */
export function RenewNow({ host, facts }: { host: string; facts: CertFacts | null }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const renew = useMutation(
    trpc.ingress.renewCert.mutationOptions({
      onSuccess: (r) => {
        toast[renewOutcomeTone(r.outcome)](r.message);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!facts?.cert) return null;
  const blocked = renewBlockedLine(facts.renew);
  return (
    <div className="border-border flex flex-col gap-1.5 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">Renew now</span>
        {facts.renew.available ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={renew.isPending}>
                <RefreshCwIcon className={renew.isPending ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'} />
                {renew.isPending ? 'Renewing…' : 'Renew now'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Get a new certificate for {host} now?</AlertDialogTitle>
                <AlertDialogDescription>{RENEW_WHAT} {RENEW_COST}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => renew.mutate({ host })}>Renew now</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
      <p className="text-muted-foreground text-[12.5px]">{blocked ?? RENEW_COST}</p>
      <Tech>ingress.renewCert · audited ingress.renewCert · on the edge: reload without the host, move its stored certificate aside, reload, wait 120 s for the new .crt, else put it back</Tech>
    </div>
  );
}
