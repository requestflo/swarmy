import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { StatusWord, Tech, toneFromStatus } from '@/components/calm';
import { relTime } from '@/lib/format';
import type { AppEnvironment } from '../gitops-types';
import { envLabel, planStatus, sha7 } from '../plan-status';
import type { LaneService } from './lanes-model';

/**
 * One environment, side by side with the others: its branch and stack, the
 * last plan, and every live service with its copies and the image it runs —
 * blue where production runs something else.
 */
export function EnvLane({
  env,
  services,
  drift,
  here,
  action,
  note,
}: {
  env: AppEnvironment;
  services: LaneService[] | undefined;
  /** Live differs from git on these many fields (the drift check). */
  drift: number;
  /** This lane is the stack whose page this is. */
  here: boolean;
  action?: React.ReactNode;
  /** A line under the status (a cloned environment's declaration + secrets). */
  note?: React.ReactNode;
}): React.JSX.Element {
  const latest = env.latest;
  const st = latest ? planStatus(latest.status) : null;
  return (
    <section aria-label={envLabel(env.environment)} className={cn('calm-card flex min-w-0 flex-col gap-3 px-4 py-3.5', here && 'ring-foreground/15 ring-1')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-display text-[15px] font-bold">{envLabel(env.environment)}</span>
        <span className="bg-muted rounded-md px-1.5 py-0.5 font-mono text-[11px]">{env.branch || '—'}</span>
        {here ? (
          <span className="text-muted-foreground font-mono text-[11px]">{env.stack}</span>
        ) : (
          <Link to="/stacks/$name/releases" params={{ name: env.stack }} className="text-muted-foreground font-mono text-[11px] hover:underline">
            {env.stack}
          </Link>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        {st ? <StatusWord tone={toneFromStatus(st.tone)} word={st.label} /> : <span className="text-muted-foreground">Waiting for the first push</span>}
        {latest ? <span className="text-muted-foreground font-mono text-[11px]">{`${sha7(latest.sha)} · ${relTime(latest.appliedAt ?? latest.createdAt)}`}</span> : null}
        {drift > 0 ? <span className="text-tone-warn text-xs">Changed here — the next push puts git back</span> : null}
      </div>
      {note}
      {services === undefined ? (
        <div aria-hidden className="shimmer-line h-16 rounded-lg" />
      ) : services.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">Nothing running in {env.stack} right now.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {services.map((s) => (
            <li key={s.name} className={cn('border-border flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2', s.differs && 'border-status-progress/60')}>
              <span className="flex items-baseline gap-1.5 text-[13px] font-semibold">
                <span className="truncate">{s.name}</span>
                <span className="text-muted-foreground ml-auto font-mono text-[10.5px] font-normal">×{s.copies}</span>
              </span>
              <span className={cn('truncate font-mono text-[11px]', s.differs ? 'text-tone-info' : 'text-muted-foreground')} title={s.image}>
                {s.ref}
              </span>
            </li>
          ))}
        </ul>
      )}
      {services && services.length > 0 ? (
        <Tech>{`stack ${env.stack} · ${services.filter((s) => s.ref.startsWith('@')).length} of ${services.length} pinned by digest`}</Tech>
      ) : null}
    </section>
  );
}
