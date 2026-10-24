import type * as React from 'react';
import { Tech } from '@/components/calm';
import { formatPit, type PitSpan, type PitWindowSource } from './pitr-scrub';

interface PgWindowNoteProps {
  span: PitSpan;
  source: PitWindowSource | null;
  /** swarmy reads the real window before it restores (wal-g, on an agent that can). */
  checked: boolean;
  /** The agent on the database's server predates the window check. */
  unsupported: boolean;
}

/** Where the scrubber's times come from, in one quiet line (the read itself at Controls). */
export function PgWindowNote({ span, source, checked, unsupported }: PgWindowNoteProps): React.JSX.Element {
  if (source === 'agent') {
    return (
      <p className="text-muted-foreground flex flex-col gap-1 text-[13px]">
        <span>These times come from the backups themselves: the earliest is {formatPit(span.fromMs)} UTC, when the oldest base copy finished.</span>
        <Tech>dbBackups.pitrWindow · wal-g backup-list --json --detail · read again before every restore</Tech>
      </p>
    );
  }
  return (
    <p className="text-muted-foreground flex flex-col gap-1 text-[13px]">
      <span>
        {unsupported
          ? "These times are an estimate from the schedule. This server's agent is too old to read the real ones, so a time before the oldest base copy fails only once the restore has started. Update the agent and swarmy checks first."
          : checked
            ? 'These times are an estimate from the schedule; swarmy checks the time against the backups before it changes anything.'
            : 'These times are an estimate from the schedule.'}
      </span>
      <Tech>pitrWindow: now − retention → last successful backup</Tech>
    </p>
  );
}
