import * as React from 'react';
import { Undo2Icon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import type { MoveRun } from './move-context';
import { undoOffer } from './move-outcome';
import { useUndoMove } from './use-undo-move';

/**
 * Board 9's "Undo" under a finished move: one button and what it does. A
 * refusal replaces the offer, in swarmy's words, and the button goes.
 */
export function MoveUndo({ run, from }: { run: MoveRun; from: string }): React.JSX.Element {
  const u = useUndoMove(run);
  if (u.refusal) {
    return (
      <p role="alert" className="text-tone-warn text-[13px] leading-relaxed">
        {u.refusal}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">{undoOffer(run.chip.short, from)}</p>
      <Button size="sm" variant="outline" disabled={u.pending} onClick={u.undo} className="w-fit pointer-coarse:min-h-11">
        <Undo2Icon aria-hidden className="size-3.5" />
        {u.pending ? 'Checking both copies…' : 'Undo'}
      </Button>
    </div>
  );
}
