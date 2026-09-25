import * as React from 'react';
import type { CostStackView } from '@swarmy/core';
import { Link } from '@tanstack/react-router';
import { Section, Tech } from '@/components/calm';

const SEG = ['bg-primary', 'bg-status-warning', 'bg-status-progress', 'bg-tone-mesh', 'bg-status-online', 'bg-status-idle'];

/** Where the money goes: one bar split by app, then the apps with their share. */
export function CostSplit({ stacks, monthlyUsd, allocatedUsd }: { stacks: CostStackView[]; monthlyUsd: number; allocatedUsd: number }): React.JSX.Element {
  const sorted = [...stacks].sort((a, b) => b.monthlyUsd - a.monthlyUsd);
  const headroom = Math.max(0, monthlyUsd - allocatedUsd);
  const whole = Math.max(monthlyUsd, allocatedUsd, 1);
  return (
    <Section title="Where the money goes" hint="each server’s price, split by how much memory each app uses on it">
      <div className="bg-secondary flex h-3 w-full overflow-hidden rounded-full" aria-hidden>
        {sorted.map((s, i) => (
          <span key={s.stack} className={SEG[i % SEG.length]} style={{ width: `${(s.monthlyUsd / whole) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-col">
        {sorted.map((s, i) => (
          <li key={s.stack} className="border-border flex min-h-11 items-center gap-3 border-b py-1.5 last:border-b-0">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-sm ${SEG[i % SEG.length]}`} />
            <Link to="/stacks/$name" params={{ name: s.stack }} className="min-w-0 flex-1 truncate text-[14px] font-semibold hover:underline">
              {s.stack}
            </Link>
            <Tech>{`${s.serviceCount} services${s.partial ? ' · on unpriced servers too (a floor)' : ''}`}</Tech>
            <span className="font-mono text-[13px] font-semibold">
              ${Math.round(s.monthlyUsd)}
              <span className="text-muted-foreground font-normal">/mo</span>
            </span>
          </li>
        ))}
        <li className="flex min-h-11 items-center gap-3 py-1.5">
          <span aria-hidden className="bg-secondary size-2.5 shrink-0 rounded-sm" />
          <span className="text-muted-foreground flex-1 text-[14px]">Spare room on the servers</span>
          <span className="text-muted-foreground font-mono text-[13px]">${Math.round(headroom)}/mo</span>
        </li>
      </ul>
    </Section>
  );
}
