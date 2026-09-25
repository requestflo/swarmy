import * as React from 'react';
import type { BlueprintOptionView, BlueprintSize } from '@swarmy/core';
import { cn, Input, Switch } from '@swarmy/ui';

const SIZE_HINTS: Record<BlueprintSize, string> = {
  s: 'Solo · 1 copy, one database',
  m: 'Team · 2 copies, a standby database',
  l: 'Scale · 3 copies, two standby databases',
};

/**
 * Nodes a size needs before its DB replicas can all schedule (replicas are
 * anti-affine to the primary): mirrors SIZE_PRESETS.dbReplicas + 1 server-side.
 */
export const SIZE_MIN_NODES: Record<BlueprintSize, number> = { s: 1, m: 2, l: 3 };

/** The size to preselect for a swarm with `onlineNodes` nodes online. */
export function defaultSizeForNodes(onlineNodes: number | undefined): BlueprintSize {
  return onlineNodes !== undefined && onlineNodes < SIZE_MIN_NODES.m ? 's' : 'm';
}

/** The S/M/L segmented picker (drives replica + memory presets server-side). */
export function BlueprintSizePicker({
  value,
  onChange,
  onlineNodes,
}: {
  value: BlueprintSize;
  onChange: (size: BlueprintSize) => void;
  /** Online node count; undefined while loading (no hints shown). */
  onlineNodes?: number;
}): React.JSX.Element {
  return (
    <div>
      <span className="text-sm font-medium">Size</span>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {(['s', 'm', 'l'] as const).map((s) => {
          const needs = SIZE_MIN_NODES[s];
          const short = onlineNodes !== undefined && onlineNodes < needs;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              className={cn(
                'min-w-0 rounded-xl border px-3 py-2 text-left transition-colors',
                value === s ? 'border-primary bg-primary/10' : 'hover:bg-accent',
              )}
            >
              <span className="mono-data text-sm font-bold uppercase">{s}</span>
              <span className="text-muted-foreground mt-0.5 block text-[11px] leading-tight">
                {SIZE_HINTS[s]}
              </span>
              {short ? (
                <span className="text-tone-warn mt-1 block text-[11px] leading-tight">
                  Needs {needs}+ servers for the standby database
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One catalog-declared per-blueprint option (string input or boolean switch). */
export function BlueprintOptionField({
  option,
  value,
  onChange,
}: {
  option: BlueprintOptionView;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}): React.JSX.Element {
  if (option.kind === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium">{option.label}</span>
          {option.help ? <p className="text-muted-foreground text-xs">{option.help}</p> : null}
        </div>
        <Switch checked={Boolean(value ?? option.defaultValue)} onCheckedChange={onChange} />
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <span className="mono-label">{option.label}</span>
      <Input
        className="font-mono"
        placeholder={option.placeholder}
        value={String(value ?? option.defaultValue ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
      {option.help ? <p className="text-muted-foreground text-xs">{option.help}</p> : null}
    </div>
  );
}
