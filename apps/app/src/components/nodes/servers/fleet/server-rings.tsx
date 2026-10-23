import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { Rings } from './fleet-model';

const SIZE = 80;
const RINGS: { key: keyof Rings; label: string; r: number; opacity: number }[] = [
  { key: 'cpu', label: 'CPU', r: 36, opacity: 1 },
  { key: 'mem', label: 'memory', r: 28, opacity: 0.85 },
  { key: 'disk', label: 'disk', r: 20, opacity: 0.7 },
];

/** Ring colour: calm, then busy (blue) from 60%, then needs you (amber) from 80%. */
export function ringTone(v: number): string {
  return v >= 80 ? 'text-status-warning' : v >= 60 ? 'text-status-progress' : 'text-status-online';
}

/**
 * A server's three rings, the estate map's ring gauge grown to board 11:
 * CPU outside (its % in the core), memory in the middle, disk inside. A ring
 * without a live number stays a dashed track — never a fake zero.
 */
export function ServerRings({ rings }: { rings: Rings }): React.JSX.Element {
  const label = RINGS.map((x) => `${x.label} ${rings[x.key] === null ? 'unknown' : `${rings[x.key]}%`}`).join(', ');
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label} className="shrink-0">
      <title>{label}</title>
      {RINGS.map(({ key, r, opacity }) => {
        const v = rings[key];
        const c = 2 * Math.PI * r;
        return (
          <g key={key}>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={r} fill="none" stroke="currentColor" strokeWidth={5} className="text-foreground/10" strokeDasharray={v === null ? '3 4' : undefined} />
            {v !== null ? (
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={r}
                fill="none"
                strokeWidth={5}
                strokeLinecap="round"
                stroke="currentColor"
                opacity={opacity}
                className={cn(ringTone(v))}
                strokeDasharray={`${(Math.max(2, v) / 100) * c} ${c}`}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
            ) : null}
          </g>
        );
      })}
      <text x="50%" y="50%" dy="0.35em" textAnchor="middle" className="fill-foreground font-mono text-[12px] font-semibold">
        {rings.cpu === null ? '—' : `${rings.cpu}%`}
      </text>
    </svg>
  );
}
