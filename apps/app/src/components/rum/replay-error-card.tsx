import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BugIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { frameLine, linkedError, requestLine } from './replay-error-model';
import { clock, type ReplayDetail } from './rum-shared';

interface ReplayErrorCardProps {
  stack: string;
  detail: ReplayDetail;
  /** First event's time, to turn the error's timestamp into a player offset. */
  start: number;
  onSeek: (t: number) => void;
}

/**
 * The error this visit hit, under the player: its message, the frame it threw
 * at (source-mapped when a map resolved it), the request it broke and its
 * trace — with the issue and the trace one click away. Nothing when no
 * tracked error is linked to the visit.
 */
export function ReplayErrorCard({ stack, detail, start, onSeek }: ReplayErrorCardProps): React.JSX.Element | null {
  const trpc = useTRPC();
  const err = linkedError(detail.errors);
  const issue = useQuery({
    ...trpc.errors.issue.queryOptions({
      stack,
      fingerprint: err?.fingerprint ?? '',
      ...(err?.eventId ? { eventId: err.eventId } : {}),
    }),
    enabled: !!err,
    staleTime: 60_000,
  });
  if (!err) return null;
  const frame = frameLine(issue.data?.event);
  const request = requestLine(detail.requests, err.traceId);
  const t = err.tsMs != null ? Math.max(0, err.tsMs - start) : null;
  const facts = [frame, request, err.traceId ? `trace ${err.traceId.slice(0, 8)}…` : null].filter(Boolean);

  return (
    <section
      aria-label="Error in this visit"
      className="calm-card shadow-none border-status-offline/40 flex flex-col gap-2 p-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BugIcon className="text-tone-bad size-4 shrink-0" aria-hidden />
        <b className="min-w-0 truncate font-mono text-sm" title={err.title}>
          {err.title}
        </b>
        {t != null ? (
          <button
            type="button"
            onClick={() => onSeek(t)}
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0 font-mono text-xs"
          >
            at {clock(t)}
          </button>
        ) : null}
      </div>
      {facts.length ? (
        <p className="text-muted-foreground font-mono text-xs break-all" title={err.traceId ?? undefined}>
          {facts.join(' · ')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/stacks/$name/errors/$fingerprint" params={{ name: stack, fingerprint: err.fingerprint }}>
            Open issue
          </Link>
        </Button>
        {err.traceId ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/observability/$traceId" params={{ traceId: err.traceId }}>
              Open trace
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
