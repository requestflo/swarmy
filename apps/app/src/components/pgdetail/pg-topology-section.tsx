import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Section, Tech, useDepth } from '@/components/calm';
import { FlowDiagram } from '@/components/stack-data/flow-diagram';
import { serverList } from '@/components/stack-data/use-member-servers';
import { modeFacts } from './pg-mode-facts';
import { MODE_WORDS, PREVIEW_MODES, pgTopology, type PgMode } from './pg-topology';
import type { PgDetailCluster, PgDetailData } from './use-pg-detail';

const GRID = { backgroundImage: 'radial-gradient(circle, color-mix(in oklch, var(--foreground) 9%, transparent) 1px, transparent 1px)', backgroundSize: '18px 18px' };

function serversOf(c: PgDetailCluster, place: PgDetailData['place'], role: 'primary' | 'replica'): NodeSummary[] {
  const all = c.members.filter((m) => m.role === role).flatMap((m) => place?.get(m.service) ?? []);
  return all.filter((n, i) => all.findIndex((x) => x.id === n.id) === i);
}

/**
 * How one database is laid out (board 39): pick a shape and the diagram
 * morphs — the real members on their servers, and what the shape would add
 * or drop — with what you could lose and how long it's down under it.
 */
export function PgTopologySection({
  stack,
  d,
  mode,
  onMode,
  behind,
}: {
  stack: string;
  d: PgDetailData;
  mode: PgMode;
  onMode: (m: PgMode) => void;
  behind?: Map<string, { stat: string; warn: boolean }>;
}): React.JSX.Element {
  const c = d.cluster!;
  const tech = useDepth().atLeast('controls');
  const modes = PREVIEW_MODES.includes(c.topology) ? PREVIEW_MODES : [...PREVIEW_MODES, c.topology];
  const model = pgTopology({ mode, current: c.topology, members: c.members, place: d.place, heldTarget: c.pendingFailover?.target ?? null, tech, behind });
  const primary = serversOf(c, d.place, 'primary');
  const standby = serversOf(c, d.place, 'replica');
  const facts = modeFacts(mode, c, d.backup, {
    primary: primary[0]?.name ?? null,
    standbys: serverList(standby),
    sameServer: standby.some((n) => primary.some((p) => p.id === n.id)),
    region: c.writeRegion ?? primary[0]?.region ?? null,
    drill: d.drill,
    ref: `${stack}/${c.name}`,
    now: Date.now(),
  });
  const preview = mode !== c.topology;

  return (
    <Section title="How it’s laid out" hint={preview ? `a preview · today it’s ${MODE_WORDS[c.topology].label.toLowerCase()}` : undefined}>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" role="group" aria-label="Shape">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={m === mode}
            onClick={() => onMode(m)}
            className={cn(
              'flex min-h-11 flex-col items-start rounded-xl border px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              m === mode ? 'border-foreground/30 bg-muted' : 'hover:bg-muted/50',
            )}
          >
            <b className="text-[13px] font-semibold">
              {MODE_WORDS[m].label}
              {m === c.topology ? <span className="text-tone-ok"> · now</span> : null}
            </b>
            <span className="text-muted-foreground text-[11.5px]">{MODE_WORDS[m].hint}</span>
          </button>
        ))}
      </div>
      <div className="relative flex flex-col gap-3 rounded-2xl border p-4" style={GRID}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="calm-eyebrow">{preview ? 'If you switch' : c.topology === 'single' ? 'One copy · live' : 'Every change copied · live'}</span>
          <Tech className="ml-auto">RW {c.rwHost} · RO {c.roHost}</Tech>
        </div>
        <FlowDiagram columns={model.columns} links={model.links} label={`${c.name} as ${MODE_WORDS[mode].label}`} />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Could lose</dt>
          <dd className="font-medium">{facts.lose}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Down for</dt>
          <dd className="font-medium">{facts.down}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground -mt-1 text-[13.5px] leading-relaxed">{facts.say}</p>
      <Tech>
        could lose = RPO · down for = RTO · swarmy.db.topology={mode} · {facts.tech}
      </Tech>
    </Section>
  );
}
