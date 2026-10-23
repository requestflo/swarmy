import * as React from 'react';
import { PauseIcon, PlayIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

/** What pausing a BullMQ queue means, while it is paused. */
export function QueuePausedNote({ name, busy, onResume }: { name: string; busy: boolean; onResume: () => void }): React.JSX.Element {
  return (
    <div role="status" className="border-status-warning/35 bg-status-warning/10 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5 text-sm">
      <PauseIcon className="text-tone-warn size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{name} is paused.</span> Workers finish active jobs; nothing new starts. Producers
        can still add jobs.
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={onResume}>
        <PlayIcon className="size-3.5" /> Resume
      </Button>
    </div>
  );
}
