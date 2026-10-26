import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { RequestIdLink } from './replay-request-id-model';

interface ReplayRequestIdProps {
  stack: string;
  id: string;
  /** The logs search for it; null when telemetry is off for the app or the request is too old to reach. */
  link: RequestIdLink | null;
}

/**
 * Under a failed request in the replay's Requests list (board 59): the id the
 * edge gave it, selectable to copy, and — with telemetry on — the app's logs
 * searched for that id.
 */
export function ReplayRequestId({ stack, id, link }: ReplayRequestIdProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 pr-2.5 pb-2 pl-[6.875rem] font-mono text-[10.5px]">
      <span className="text-muted-foreground shrink-0">request id</span>
      <span className="min-w-0 truncate select-all" title={id}>
        {id}
      </span>
      {link ? (
        <Link
          to="/stacks/$name/observability"
          params={{ name: stack }}
          search={link}
          className="text-muted-foreground hover:text-foreground ml-auto shrink-0 underline-offset-2 hover:underline pointer-coarse:py-3"
        >
          Find in logs →
        </Link>
      ) : null}
    </div>
  );
}
