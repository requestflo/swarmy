import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, Section, TONE_DOT } from '@/components/calm';
import { RegionPlanEditor } from '@/components/services/region-plan-editor';
import { CardSkeleton } from '@/components/states';
import { pinnedServer } from '../scaling/scaling-model';
import { shortName } from '../use-stack-services';
import { meaningNotes, type SingleCopy } from './meaning-model';
import { RegionMap } from './region-map';
import { RegionToggles } from './region-toggles';
import type { PlacementPage } from './use-placement-page';

/**
 * Where the picked part may run (board AppPlacement): the region switches,
 * the map of this app's copies, and "What this means". The exact copies per
 * region are the region plan editor, at Controls.
 */
export function RegionsSection({ stack, page }: { stack: string; page: PlacementPage }): React.JSX.Element | null {
  const { picked, rows, nodes, declared, known, map } = page;
  const notes = React.useMemo(() => {
    if (!picked || !rows || !nodes || !map || !declared) return null;
    const singles: SingleCopy[] = rows
      .filter((r) => r.inv.mode === 'replicated' && r.inv.replicas.desired === 1)
      .map((r) => {
        const part = shortName(stack, r.inv.name);
        const pin = pinnedServer(r.detail, nodes);
        const where = map.flatMap((g) => g.servers).find((s) => s.parts.includes(part));
        return { part, server: pin?.name ?? where?.node.name ?? null, pinned: !!pin && (r.detail?.volumes ?? []).some((v) => v.type === 'volume' && v.source) };
      });
    const part = shortName(stack, picked.inv.name);
    const all = meaningNotes({ part, declared: [...declared.keys()].sort(), map, singles });
    // A pinned part's one line is its single-copy note; how far it's spread doesn't apply.
    return pinnedServer(picked.detail, nodes) ? all.filter((n) => n.tone !== 'ok' && n.tone !== 'warn') : all;
  }, [picked, rows, nodes, map, declared, stack]);
  if (!picked) return null;
  const name = shortName(stack, picked.inv.name);
  const global = picked.inv.mode === 'global';
  const pin = nodes ? pinnedServer(picked.detail, nodes) : undefined;
  return (
    <Section title={`Where ${name} may run`} hint="you pick regions; swarmy picks the servers">
      {!declared || !known || !nodes ? (
        <CardSkeleton lines={1} />
      ) : global ? (
        <p className="text-[13.5px]">{name} runs one copy on every server, so it’s in every region already.</p>
      ) : pin ? (
        <p className="text-[13.5px]">
          {(picked.detail?.volumes ?? []).some((v) => v.type === 'volume' && v.source)
            ? `${name} stays on ${pin.name} with its data, so it doesn’t pick regions: a copy elsewhere would start without it. To change servers, use Move… on its volume below.`
            : `${name} is pinned to ${pin.name}${pin.region ? ` in ${pin.region}` : ''}, so regions don’t apply while the pin stays. Its placement rule is at Controls.`}
        </p>
      ) : known.length === 0 ? (
        <p className="text-muted-foreground text-[13.5px]">No server has a region yet, so {name} goes wherever there’s room. Give servers a region on Servers to pick here.</p>
      ) : (
        <RegionToggles name={name} inv={picked.inv} declared={declared} known={known} nodes={nodes} />
      )}
      <RegionMap map={map} part={name} declared={declared ?? new Map()} />
      {notes && notes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="calm-eyebrow">What this means</span>
          <ul className="flex flex-col gap-1.5">
            {notes.map((n) => (
              <li key={n.text} className="flex items-start gap-2 text-[13.5px] leading-snug">
                <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[n.tone])} />
                <span>{n.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {global || pin ? null : (
        <Depth at="controls">
          <RegionPlanEditor serviceId={picked.inv.id} />
        </Depth>
      )}
    </Section>
  );
}
