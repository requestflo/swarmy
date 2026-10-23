import * as React from 'react';
import type { InvService } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { cn } from '@swarmy/ui';
import { Section, TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { healthWords } from './health-model';

/**
 * Health check (board AppRollout): how swarmy knows a copy is healthy, read
 * off the live spec and said plainly. Read-only — the check lives in the
 * app's compose / Dockerfile, and services.update has no field for it.
 */
export function HealthCheckSection({ name, inv, spec }: { name: string; inv: InvService; spec: ServiceSpec | null | undefined }): React.JSX.Element {
  const { desired, running } = inv.replicas;
  const w = spec ? healthWords(spec.healthcheck) : null;
  const tone = desired > 0 && running >= desired ? 'ok' : running === 0 && desired > 0 ? 'bad' : desired === 0 ? 'idle' : 'warn';
  const chip = (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-[11.5px] font-semibold', TONE_TEXT[tone])}>
      <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {running} / {desired} {w?.kind === 'check' ? 'healthy' : 'running'}
    </span>
  );
  return (
    <Section title="Health check" hint={`how swarmy knows ${name} is healthy`} action={chip}>
      {spec === undefined ? (
        <CardSkeleton lines={2} />
      ) : spec === null || !w ? (
        <p className="text-muted-foreground text-[13.5px]">swarmy couldn’t read {name}’s settings just now, so its health check isn’t shown.</p>
      ) : w.kind !== 'check' ? (
        <>
          <p className="text-[13.5px]">
            {w.kind === 'off' ? `${name}’s health check is switched off.` : `${name} has no health check.`} A copy counts as up as soon as it starts, so a
            new version that starts and then fails still takes over.
          </p>
          <Tech>{w.kind === 'off' ? 'healthcheck: disable: true' : 'no HEALTHCHECK in the image or the compose file'} · add one in swarmy.yaml (healthcheck.path) or compose</Tech>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <Fact label="Ask for" value={w.ask} sub={w.askSub} wide />
            {w.facts.map((f) => (
              <Fact key={f.label} label={f.label} value={f.value} sub={f.dflt ? 'Docker’s default' : null} />
            ))}
          </dl>
          <p className="text-muted-foreground text-[13px]">
            Each copy is asked on its own server. A new copy only takes visitors once it answers, and one that stops answering is replaced.
          </p>
          <Tech>healthcheck test {w.raw}</Tech>
        </>
      )}
    </Section>
  );
}

function Fact({ label, value, sub, wide }: { label: string; value: string; sub: string | null; wide?: boolean }): React.JSX.Element {
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
