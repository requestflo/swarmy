import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

interface SnapshotFailureReasonProps {
  /** The captured restic / agent error for a FAILED run. */
  error: string | null | undefined;
  className?: string;
}

/**
 * Why a backup run failed — the error the agent captured, shown inline under
 * the row. Collapsed to one truncated line; tap to expand the full text so a
 * wrong endpoint, bad credentials or a full disk is readable without node access.
 */
export function SnapshotFailureReason({
  error,
  className,
}: SnapshotFailureReasonProps): React.JSX.Element | null {
  const [expanded, setExpanded] = React.useState(false);
  const text = error?.trim();
  if (!text) return null;
  const long = text.length > 96 || text.includes('\n');
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      disabled={!long}
      title={long && !expanded ? 'Show the full error' : undefined}
      className={cn(
        'text-tone-bad mt-1 flex w-full min-w-0 items-start gap-1 text-left text-xs disabled:cursor-default',
        className,
      )}
    >
      <span className="mono-label shrink-0 !mb-0">failed:</span>
      <span
        className={cn(
          'mono-data min-w-0 flex-1 break-words leading-snug',
          expanded ? 'max-h-48 overflow-auto whitespace-pre-wrap' : 'truncate',
        )}
      >
        {expanded ? text : text.split('\n')[0]}
      </span>
      {long ? (
        <ChevronDownIcon
          className={cn('mt-0.5 size-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
        />
      ) : null}
    </button>
  );
}
