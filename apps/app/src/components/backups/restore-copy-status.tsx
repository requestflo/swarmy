import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { fmtBytes } from './backup-format';
import type { RestoreCopy } from './use-restore-copy';

interface RestoreCopyStatusProps {
  stack: string;
  cluster: string;
  copy: RestoreCopy;
  /** What is being loaded ("the save of 03:00 UTC"), for the running line. */
  what?: string;
}

/**
 * The copy restore's running line, then what it made: the new database, that
 * nothing changes until the app is switched to it, and "Remove the copy"
 * (a second click confirms; `db.remove` with its data).
 */
export function RestoreCopyStatus({ stack, cluster, copy, what }: RestoreCopyStatusProps): React.JSX.Element | null {
  const [confirming, setConfirming] = React.useState(false);
  const done = copy.done;
  if (copy.running) {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-[13px]">
        <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        Creating {copy.running}, waiting for it to answer, then loading {what ?? 'the save'} into it. {cluster} keeps serving.
      </p>
    );
  }
  if (copy.removed) {
    return (
      <p role="status" className="text-muted-foreground text-[13px]">
        Removed {copy.removed} and its data. {cluster} was never touched.
      </p>
    );
  }
  if (!done) return null;
  const name = done.copy.cluster;
  return (
    <div role="status" className="flex flex-col gap-1.5">
      <p className="text-tone-ok text-[13px]">
        Restored {fmtBytes(done.bytesRestored)} into {name}
        {done.recoveredTo ? `, up to ${done.recoveredTo}` : ''}.
      </p>
      <p className="text-[13px]">
        Nothing changes until you switch {stack} to it, on its{' '}
        <Link to="/stacks/$name/data" params={{ name: stack }} className="text-primary hover:underline">
          Data tab
        </Link>
        .
      </p>
      <Tech>
        {done.copy.rwHost} · 1 copy · wired into no app
      </Tech>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[13px]">Remove {name} and its data?</span>
            <Button size="sm" variant="destructive" disabled={copy.remove.isPending} onClick={() => copy.removeCopy(name)} className="pointer-coarse:min-h-11">
              {copy.remove.isPending ? 'Removing…' : 'Remove it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="pointer-coarse:min-h-11">
              Keep it
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)} className="pointer-coarse:min-h-11">
            Remove the copy
          </Button>
        )}
      </div>
    </div>
  );
}
