import * as React from 'react';
import { failoverPolicy } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Section, StatusWord, TONE_TEXT, Tech } from '@/components/calm';
import { DbFailoverConfirm } from '@/components/stacks/db-failover-confirm';
import { outageScope, simulateOutage, simWords } from './pg-failover-sim';
import { shortName } from './pg-topology';
import type { PgDetailData } from './use-pg-detail';

/**
 * Switch-over (board 39): the rule in plain words, the best standby copy,
 * whether switching over by itself can honestly work here
 * (`db.failoverReadiness`), a held switch-over's confirm, and "Simulate
 * <region> outage" — the worker's own `decideFailover` on what would survive.
 */
export function PgFailoverSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const c = d.cluster!;
  const [sim, setSim] = React.useState(false);
  const policy = failoverPolicy(c.topology);
  const held = c.pendingFailover ?? null;
  const primary = c.members.filter((m) => m.role === 'primary').flatMap((m) => d.place?.get(m.service) ?? []);
  const scope = d.place ? outageScope(primary, d.nodes) : null;
  const result = sim && scope && d.place ? simulateOutage(c.topology, c.members, d.place, scope, Date.now()) : null;
  const serverOf = (svc: string): string => d.place?.get(svc)?.find((n) => !scope?.serverIds.includes(n.id))?.name ?? shortName(svc);

  const best = c.members
    .filter((m) => m.role === 'replica' && m.running > 0)
    .sort((a, b) => (a.lagSeconds ?? Infinity) - (b.lagSeconds ?? Infinity))[0];
  const bestServer = best ? d.place?.get(best.service)?.[0] : undefined;

  return (
    <Section
      title="Switch-over"
      hint={<StatusWord tone={held ? 'bad' : policy === 'never' ? 'idle' : 'ok'} word={held ? 'held · needs you' : policy === 'never' ? 'never switches over' : 'by itself when caught up'} />}
      action={
        <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={!scope} aria-pressed={sim} onClick={() => setSim((v) => !v)}>
          {sim ? 'Stop simulating' : `Simulate ${scope ? `${scope.label} ` : 'an '}outage`}
        </Button>
      }
    >
      {held ? <DbFailoverConfirm stack={stack} cluster={c.name} pending={held} /> : null}
      {result ? (
        <div role="status" className="flex flex-col gap-2 rounded-xl border px-3.5 py-3">
          <span className="calm-eyebrow">If {result.scope.label} went dark now</span>
          {simWords(result, serverOf).map((l) => (
            <p key={l.lead} className="text-[13px] leading-relaxed">
              <b className={cn('font-semibold', TONE_TEXT[l.tone])}>{l.lead}</b> <span className="text-muted-foreground">{l.rest}</span>
            </p>
          ))}
          <Tech>
            decideFailover · caught up → {result.caughtUp.kind}
            {result.caughtUp.kind === 'promote' ? ` ${shortName(result.caughtUp.target)}` : ''} · 1 byte behind → {result.behind.kind} · no watermark → {result.unknown.kind}
            {'reason' in result.unknown ? ` (${result.unknown.reason})` : ''}
          </Tech>
        </div>
      ) : (
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Standby copies follow the main copy a moment behind. swarmy switches over by itself only when one is{' '}
          <b className="text-foreground font-semibold">provably caught up</b>: it has every change the main copy saved. Seconds behind are never
          proof. Otherwise it holds and asks an owner or admin, showing what could be lost.
        </p>
      )}
      <Tech>promote only if replay LSN ≥ the primary’s last flushed LSN (0 bytes behind) · else swarmy.db.failover.pending + incident · confirm needs data.failover</Tech>
      {policy === 'gated' ? (
        <div className="bg-muted/60 flex items-center gap-3 rounded-xl px-3.5 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="calm-eyebrow">Best standby copy</span>
            <b className="truncate text-[13.5px] font-semibold">
              {best ? `${bestServer?.name ?? shortName(best.service)}${bestServer?.region ? ` · ${bestServer.region}` : ''}` : 'none running'}
            </b>
          </span>
          {best ? (
            <span className="text-right font-mono text-[12px]">
              {best.lagSeconds !== undefined ? `${best.lagSeconds} s behind` : 'not measured yet'}
              <span className="text-muted-foreground block text-[10.5px]">at the last check</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {d.readiness ? (
        <p className={cn('text-[12.5px] leading-relaxed', d.readiness.ok ? 'text-muted-foreground' : 'text-tone-warn')}>
          {d.readiness.ok
            ? 'Switching over by itself can work here: the standby copy can live on a different server from the main one.'
            : 'Switching over by itself can’t work here yet.'}{' '}
          <Tech>{d.readiness.ok ? d.readiness.survives : d.readiness.reason}</Tech>
        </p>
      ) : null}
    </Section>
  );
}
