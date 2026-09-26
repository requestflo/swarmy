import * as React from 'react';

function Key({ k, label }: { k: string; label: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="border-border bg-muted rounded border px-1.5 py-px font-mono text-[10.5px]">{k}</kbd>
      {label}
    </span>
  );
}

/** The key hints — only keys the palette really handles (⇥ only when the row has a page to edit it on). */
export function PaletteFooter({ canEdit, canRun }: { canEdit: boolean; canRun: boolean }): React.JSX.Element {
  return (
    <div className="text-muted-foreground hidden flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 font-mono text-[11px] sm:flex">
      <Key k="↑↓" label="move" />
      <Key k="↵" label="run with preview" />
      {canEdit ? <Key k="⇥" label="edit" /> : null}
      {canRun ? <Key k="⌘↵" label="run now" /> : null}
      <Key k="esc" label="close" />
      <span className="ml-auto">Every action is checked against your role and logged</span>
    </div>
  );
}
