import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth, TONE_DOT, TONE_TEXT, type Tone } from '@/components/calm';
import { DRAG_TYPE, dragFromType, useMove } from '../move/move-context';
import type { TargetPlan } from '../move/use-move-plan';
import { serverTone, techRoles } from '../server-words';
import { FleetBadges } from './fleet-badges';
import { TILE_CHIPS, yours, type FleetView } from './fleet-model';
import { ServerRings } from './server-rings';
import { ServiceChip } from './service-chip';

const VERDICT_TONE: Record<string, Tone> = { fits: 'ok', tight: 'warn', 'wont-fit': 'bad', unknown: 'idle' };
const VERDICT_RING: Record<Tone, string> = {
  ok: 'ring-status-online',
  warn: 'ring-status-warning',
  bad: 'ring-status-offline',
  info: 'ring-status-progress',
  mesh: 'ring-tone-mesh',
  idle: 'ring-foreground/30',
};

const pctOr = (v: number | null): string => (v === null ? '—' : `${v}%`);

/** Memory now, or before → after while a service hovers here (board 9's "RAM 35% → 52%"). */
function MemoryLine({ v, plan }: { v: FleetView; plan: TargetPlan | null }): React.JSX.Element {
  if (plan?.block) return <span className="text-tone-bad">can’t take it</span>;
  if (plan && plan.fit.afterPct !== null) {
    return (
      <span className={TONE_TEXT[VERDICT_TONE[plan.fit.verdict]!]}>
        mem {plan.fit.beforePct}% → {plan.fit.afterPct}%
      </span>
    );
  }
  return <span className="text-muted-foreground">memory {pctOr(v.rings.mem)}</span>;
}

/**
 * One server on the map: three rings, name, role badges, memory and disk,
 * and your services as chips. Click to inspect (or, selecting, to pick);
 * drop a dragged service on it to move that service here.
 */
export function FleetTile({
  v,
  selected,
  picking,
  picked,
  onPick,
  plan,
  style,
  className,
}: {
  v: FleetView;
  selected: boolean;
  picking: boolean;
  picked: boolean;
  onPick: (id: string) => void;
  /** This server as the hovered drop target (null otherwise). */
  plan: TargetPlan | null;
  style?: React.CSSProperties;
  className?: string;
}): React.JSX.Element {
  const m = useMove();
  const n = v.server.node;
  const st = serverTone(n);
  const chips = yours(v);
  const droppable = m.stage === 'drag' && m.draft?.fromId !== n.id;
  // The hovered tile while dragging, then the chosen one while confirming.
  const hovered = (droppable || m.stage === 'confirm') && m.target === n.id;
  // Read from the drag's types, not state: the first dragover can beat the re-render.
  const accepts = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DRAG_TYPE) && !e.dataTransfer.types.includes(dragFromType(n.id));
  return (
    <article
      aria-label={`Server ${n.name}`}
      style={style}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        // Claimed here; the map clears the hover when the drag is over anything else.
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        m.hover(n.id);
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        m.choose(n.id);
      }}
      className={cn(
        'bg-card border-border flex flex-col gap-2.5 overflow-hidden rounded-xl border p-3 shadow-sm transition-shadow',
        selected && !picking && 'ring-foreground/35 ring-2',
        picked && 'ring-status-progress ring-2',
        droppable && !hovered && 'border-dashed',
        hovered && cn('ring-2', VERDICT_RING[plan?.block ? 'bad' : VERDICT_TONE[plan?.fit.verdict ?? 'unknown']!]),
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onPick(n.id)}
        aria-pressed={picking ? picked : selected}
        aria-label={`${picking ? 'Select' : 'Inspect'} ${n.name}`}
        className="focus-visible:ring-ring/50 -m-1 flex h-[88px] items-center gap-3 rounded-lg p-1 text-left outline-none focus-visible:ring-2"
      >
        <ServerRings rings={v.rings} />
        <span className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-[12px] leading-[18px]">
          <span className="text-foreground flex items-center gap-1.5 font-sans text-sm font-semibold">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[st.tone])} />
            <span className="truncate">{n.name}</span>
            {picked ? <CheckIcon aria-hidden className="text-tone-info ml-auto size-4" /> : null}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <FleetBadges node={n} nat={v.nat} />
            {st.tone !== 'ok' ? <span className={cn('truncate', TONE_TEXT[st.tone])}>{st.word.toLowerCase()}</span> : null}
          </span>
          <span className="truncate">
            <MemoryLine v={v} plan={hovered ? plan : null} />
          </span>
          <span className="text-muted-foreground truncate">disk {pctOr(v.rings.disk)}</span>
        </span>
      </button>
      <Depth at="controls">
        <p className="text-muted-foreground h-[18px] truncate font-mono text-[12px] leading-[18px]">
          {techRoles(n)} · {v.mesh.ip ? `mesh ${v.mesh.ip}` : (n.publicIp ?? 'no public ip')}
        </p>
      </Depth>
      <ul aria-label={`Services on ${n.name}`} className="flex flex-col gap-1.5">
        {chips === undefined ? (
          <li className="shimmer-line h-[28px] rounded-lg" />
        ) : chips.length === 0 ? (
          <li className="text-muted-foreground flex h-[28px] items-center text-[13px] pointer-coarse:h-11">Nothing of yours runs here</li>
        ) : (
          chips.slice(0, TILE_CHIPS).map((c) => <ServiceChip key={c.id} chip={c} fromId={n.id} />)
        )}
        {chips && chips.length > TILE_CHIPS ? (
          <li>
            <button type="button" onClick={() => onPick(n.id)} className="text-muted-foreground hover:text-foreground h-[28px] text-[13px] pointer-coarse:h-11">
              +{chips.length - TILE_CHIPS} more in the inspector
            </button>
          </li>
        ) : null}
      </ul>
    </article>
  );
}
