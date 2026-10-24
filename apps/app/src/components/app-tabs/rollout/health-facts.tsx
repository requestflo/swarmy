import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { HealthWords } from './health-model';

/** The check in plain words (Summary): what it asks for, how often, when a copy counts as unhealthy. */
export function HealthFacts({ name, w, fromImage }: { name: string; w: HealthWords; fromImage: boolean }): React.JSX.Element {
  if (w.kind !== 'check') {
    return (
      <>
        <p className="text-[13.5px]">
          {w.kind === 'off' ? `${name}’s health check is switched off.` : `${name} has no health check.`} A copy counts as up as soon as it starts, so a new
          version that starts and then fails still takes over.
        </p>
        <Tech>{w.kind === 'off' ? 'healthcheck: disable: true' : 'no HEALTHCHECK in the image or the compose file'} · add one at Controls, or in compose</Tech>
      </>
    );
  }
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Ask for" value={w.ask} sub={w.askSub} wide />
        {w.facts.map((f) => (
          <Fact key={f.label} label={f.label} value={f.value} sub={f.dflt ? 'Docker’s default' : null} />
        ))}
      </dl>
      <p className="text-muted-foreground text-[13px]">
        {fromImage ? 'This check comes with the image. ' : ''}Each copy is asked on its own server. A new copy only takes visitors once it answers, and one
        that stops answering is replaced.
      </p>
      <Tech>
        healthcheck test {w.raw}
        {fromImage ? ' · from the image (HEALTHCHECK)' : ''}
      </Tech>
    </>
  );
}

export function Fact({ label, value, sub, wide }: { label: string; value: string; sub: string | null; wide?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', wide && 'col-span-2 sm:col-span-1')}>
      <dt className="text-muted-foreground text-[12px]">{label}</dt>
      <dd className="truncate font-mono text-[14px] font-semibold" title={value}>
        {value}
      </dd>
      {sub ? <dd className="text-muted-foreground font-mono text-[10.5px]">{sub}</dd> : null}
    </div>
  );
}
