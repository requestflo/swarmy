import * as React from 'react';
import { GripVerticalIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import { DRAG_TYPE, dragFromType, useMove } from '../move/move-context';
import { moveStep } from '../move/move-rules';
import type { ServiceChip as Chip } from './fleet-model';

/**
 * One service on a server: status dot, name, its app — and, for admins, a
 * drag handle (board 9: drag it onto another server; ⌥-drag adds a copy
 * there). swarmy's own parts don't drag. The keyboard path is the
 * inspector's "Move…".
 */
export function ServiceChip({
  chip,
  fromId,
  className,
  children,
}: {
  chip: Chip;
  fromId: string;
  className?: string;
  /** Trailing controls (the inspector's "Move…"). */
  children?: React.ReactNode;
}): React.JSX.Element {
  const m = useMove();
  const moving = moveStep(chip.inv?.labels) !== null;
  const canDrag = m.admin && !chip.system && !moving;
  const dragging = m.stage === 'drag' && m.draft?.chip.id === chip.id;
  return (
    <li
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, chip.id);
        e.dataTransfer.setData(dragFromType(fromId), fromId);
        e.dataTransfer.effectAllowed = 'copyMove';
        m.startDrag({ chip, fromId });
      }}
      onDragEnd={() => m.endDrag()}
      title={canDrag ? `Drag ${chip.short} onto another server to move it · hold ⌥ to add a copy there` : undefined}
      className={cn(
        'bg-foreground/[0.04] flex h-[28px] min-w-0 items-center gap-2 rounded-lg px-2 text-[13px] pointer-coarse:h-11',
        canDrag && 'hover:bg-foreground/[0.08] cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        className,
      )}
    >
      {canDrag ? <GripVerticalIcon aria-hidden className="text-muted-foreground -mx-0.5 size-3.5 shrink-0" /> : null}
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[moving ? 'info' : chip.tone])} />
      <span className="text-foreground min-w-0 shrink truncate font-semibold">{chip.short}</span>
      {chip.app ? <span className="text-muted-foreground min-w-0 truncate font-mono text-[12px]">{chip.app}</span> : null}
      <span aria-hidden className="flex-1" />
      <span className={cn('shrink-0 font-mono text-[12px]', moving || chip.tone !== 'ok' ? TONE_TEXT[moving ? 'info' : chip.tone] : 'sr-only')}>
        {moving ? 'moving' : chip.word.toLowerCase()}
      </span>
      {children}
    </li>
  );
}
