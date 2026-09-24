import * as React from 'react';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';

interface ErrorStateProps {
  title?: string;
  /** The error (its message is shown), or a plain string. */
  error?: unknown;
  /** Re-runs the failed query. */
  retry?: () => void;
  retrying?: boolean;
  className?: string;
}

function messageOf(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return null;
}

/** A query failed: say so in one line, offer a retry. Never a blank page. */
export function ErrorState({
  title = 'Couldn’t load this.',
  error,
  retry,
  retrying = false,
  className,
}: ErrorStateProps): React.JSX.Element {
  const detail = messageOf(error);
  return (
    <div
      role="alert"
      className={cn(
        'card-pop border-status-offline/30 flex flex-col items-center gap-3 border py-12 text-center',
        className,
      )}
    >
      <TriangleAlertIcon className="text-status-offline size-6" />
      <div className="space-y-1 px-6">
        <p className="font-medium">{title}</p>
        {detail ? <p className="text-muted-foreground mx-auto max-w-md text-sm">{detail}</p> : null}
      </div>
      {retry ? (
        <Button
          variant="outline"
          className="rounded-full font-bold"
          onClick={retry}
          disabled={retrying}
        >
          <RefreshCwIcon className={cn('size-4', retrying && 'animate-spin')} /> Try again
        </Button>
      ) : null}
    </div>
  );
}

/** ErrorState inside the standard page container — for a route whose first query failed. */
export function PageError(props: ErrorStateProps): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <ErrorState {...props} />
    </div>
  );
}
