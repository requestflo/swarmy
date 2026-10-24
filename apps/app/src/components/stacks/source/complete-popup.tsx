import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { Completion } from './schema-complete';
import type { AutocompleteState } from './use-autocomplete';
import { CODE_LEFT, LINE_H, PAD_Y } from './yaml-lines';

/**
 * The autocomplete list under the word being typed: the schema location
 * (`resources.<name>.type`) and "↑↓ ↵" on top, one option per row. Mouse
 * down is swallowed so a click doesn't blur the textarea first.
 */
export function CompletePopup({
  id,
  state,
  onPick,
  onHover,
}: {
  id: string;
  state: AutocompleteState;
  onPick: (c: Completion) => void;
  onHover: (i: number) => void;
}): React.JSX.Element {
  const above = state.line > 12 && state.list.items.length > 3;
  const top = above ? PAD_Y + (state.line - 1) * LINE_H - 4 : PAD_Y + state.line * LINE_H + 2;
  return (
    // The anchor keeps the editor's mono font so `ch` matches the code columns.
    <div className="absolute z-10 h-0 w-0" style={{ top, left: `calc(${CODE_LEFT}px + ${state.col}ch)` }}>
      <div
        id={id}
        role="listbox"
        aria-label={`swarmy.yaml schema: ${state.list.title}`}
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          'bg-popover text-popover-foreground border-border absolute left-0 flex w-[min(320px,80vw)] flex-col gap-px rounded-xl border p-1.5 font-sans shadow-lg',
          above ? 'bottom-0' : 'top-0',
        )}
      >
        <div className="text-muted-foreground flex items-center gap-2 px-2.5 pt-1 pb-1.5 font-mono text-[10.5px]">
          <span className="truncate">{state.list.title}</span>
          <span className="ml-auto shrink-0">↑↓ ↵</span>
        </div>
        <div className="flex max-h-56 flex-col gap-px overflow-y-auto">
          {state.list.items.map((c, i) => (
            <button
              key={`${c.kind}:${c.label}`}
              id={`${id}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === state.active}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(c)}
              className={cn(
                'flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left pointer-coarse:min-h-11',
                i === state.active ? 'bg-primary/15' : 'hover:bg-accent',
              )}
            >
              <span className="w-24 shrink-0 truncate font-mono text-[12px] font-semibold">{c.label}</span>
              <span className="text-muted-foreground truncate text-xs">{c.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
