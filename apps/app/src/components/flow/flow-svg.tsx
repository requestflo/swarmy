import * as React from 'react';
import type { FlowPath, FlowTone } from './use-flow-paths';

const STROKE: Record<FlowTone, { color: string; opacity: number; width: number }> = {
  hot: { color: 'var(--color-primary)', opacity: 0.95, width: 2 },
  base: { color: 'var(--color-primary)', opacity: 0.32, width: 1.4 },
  dim: { color: 'var(--color-foreground)', opacity: 0.1, width: 1.2 },
  mesh: { color: 'var(--color-tone-mesh)', opacity: 0.6, width: 1.4 },
};

/** The links layer of a flow diagram: decorative (the cards carry the words), behind the cards. */
export function FlowSvg({ paths, size }: { paths: FlowPath[]; size: { w: number; h: number } }): React.JSX.Element | null {
  if (size.w === 0) return null;
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h}>
      {paths.map((p) => {
        const s = STROKE[p.tone];
        return (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={s.color}
            strokeOpacity={s.opacity}
            strokeWidth={s.width}
            strokeDasharray={p.dashed ? '4 5' : undefined}
            className="motion-safe:transition-[d,stroke-opacity] motion-safe:duration-300"
          />
        );
      })}
    </svg>
  );
}
