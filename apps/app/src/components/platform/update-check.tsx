import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { checkIsStale, checkedWords } from './platform-words';
import type { PlatformStatus } from './use-platform';

/**
 * "Checked 12 min ago · Check for updates", at every depth, so "Up to date"
 * never hides how old it is. Opening the page re-checks the feed once when
 * the last check is over 10 minutes old (admins only: check is gated).
 */
export function UpdateCheck({ v, admin }: { v: PlatformStatus; admin: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  // A click toasts; the automatic check on open stays quiet.
  const manual = React.useRef(false);
  const check = useMutation(
    trpc.platform.check.mutationOptions({
      onSuccess: () => {
        if (manual.current) toast.success('Checked for updates');
        void qc.invalidateQueries({ queryKey: trpc.platform.status.queryKey() });
      },
      onError: (e) => {
        if (manual.current) toast.error(e.message);
      },
    }),
  );
  const auto = React.useRef(false);
  const { lastCheckAt, lastCheckError } = v.release;
  const running = v.run?.status === 'running';
  React.useEffect(() => {
    if (auto.current || !admin || running || !checkIsStale(lastCheckAt)) return;
    // Deferred a tick and cancelled on cleanup, so a mount that is torn down
    // straight away (StrictMode, a fast navigation) never starts a check that
    // nothing is left to hear back from.
    const t = window.setTimeout(() => {
      auto.current = true;
      manual.current = false;
      check.mutate();
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, running, lastCheckAt]);

  const words = check.isPending ? 'Checking for updates…' : checkedWords(lastCheckAt, lastCheckError);
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]" aria-live="polite">
      <span className={lastCheckError && !check.isPending ? 'text-tone-warn' : undefined}>{words}</span>
      {admin ? (
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => {
            manual.current = true;
            check.mutate();
          }} disabled={check.isPending}>
          <RefreshCwIcon className="size-3.5" /> Check for updates
        </Button>
      ) : null}
    </div>
  );
}
