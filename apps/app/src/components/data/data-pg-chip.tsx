import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT } from '@/components/calm';
import { PG_STANDBY_DRAG, PG_WRITER_DRAG, type CopyChip } from './pg-copies-model';

/**
 * One copy of a database on its server (board 15). The writer drags; a
 * standby is a drop target for that writer and a button (keyboard and
 * touch: the same offer). Dragging a standby only says it stays put.
 */
export function DataPgChip({
  chip,
  dragKey,
  canDrag,
  onOffer,
  onStandbyDrag,
}: {
  chip: CopyChip;
  /** The cluster's writer drag key (`<stack>/<cluster>`). */
  dragKey: string;
  /** The writer may be dragged (a standby exists and nothing is switching). */
  canDrag: boolean;
  onOffer: (chip: CopyChip) => void;
  onStandbyDrag: () => void;
}): React.JSX.Element {
  const [over, setOver] = React.useState(0);
  const where = chip.server ?? 'placing…';
  const base = 'flex min-h-11 items-center gap-2 rounded-full border px-3 text-[12.5px] sm:min-h-8';
  if (chip.role === 'writer') {
    return (
      <span
        draggable={canDrag}
        aria-label={`${where}: the writer${canDrag ? ', drag it onto a standby copy' : ''}`}
        onDragStart={(e) => {
          e.dataTransfer.setData(PG_WRITER_DRAG, dragKey);
          e.dataTransfer.effectAllowed = 'move';
        }}
        className={cn(base, 'bg-background font-semibold', canDrag && 'cursor-grab active:cursor-grabbing')}
      >
        <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT.info)} />
        {where}
        <span className="text-muted-foreground font-mono text-[10.5px] font-normal">writes</span>
      </span>
    );
  }
  const accepts = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(PG_WRITER_DRAG);
  return (
    <button
      type="button"
      draggable
      onClick={() => onOffer(chip)}
      onDragStart={(e) => {
        e.dataTransfer.setData(PG_STANDBY_DRAG, chip.service);
        e.dataTransfer.effectAllowed = 'none';
        onStandbyDrag();
      }}
      onDragEnter={(e) => accepts(e) && setOver((v) => v + 1)}
      onDragLeave={(e) => accepts(e) && setOver((v) => Math.max(0, v - 1))}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        setOver(0);
        if (e.dataTransfer.getData(PG_WRITER_DRAG) !== dragKey) return;
        e.preventDefault();
        onOffer(chip);
      }}
      aria-label={`${where}: a standby copy. Make it the writer…`}
      className={cn(
        base,
        'bg-muted/50 hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        over > 0 && 'border-primary border-dashed shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_12%,transparent)]',
      )}
    >
      <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT.ok)} />
      {where}
      <span className="text-muted-foreground font-mono text-[10.5px]">standby</span>
    </button>
  );
}
