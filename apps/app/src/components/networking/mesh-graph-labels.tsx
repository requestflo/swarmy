import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { MeshGraph } from './mesh-graph-model';

export const pairNames = (id: string, names: Map<string, string>): string =>
  id
    .split('~')
    .map((x) => names.get(x) ?? x)
    .join(' to ');

/** The reported latency on each link ("0.4 ms", "through the relay · 19 ms"). */
export function LinkLabels({ g }: { g: MeshGraph }): React.JSX.Element {
  return (
    <>
      {g.labels.map((l) => (
        <span
          key={l.id}
          aria-hidden
          className={cn('bg-card/90 absolute rounded text-center font-mono text-[10.5px] leading-4 whitespace-nowrap', l.relayed ? 'text-tone-warn' : 'text-tone-mesh')}
          style={{ left: l.x, top: l.y, width: l.w, height: l.h }}
        >
          {l.text}
        </span>
      ))}
    </>
  );
}
