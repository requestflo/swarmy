import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Depth } from '@/components/calm';
import { ErrorState } from '@/components/states';
import { Segmented } from './rum-ui';
import { FunnelChart } from './funnel-chart';
import { FunnelDrop } from './funnel-drop';
import { FunnelReleases } from './funnel-releases';
import { funnelTitle, MAX_FUNNELS, type Funnel } from './funnel-model';
import type { useFunnel } from './use-funnels';

interface FunnelCardProps {
  stack: string;
  days: number;
  funnels: Funnel[];
  selected: Funnel;
  onPick: (id: string) => void;
  view: ReturnType<typeof useFunnel>;
  /** Identified mode: the signed-in split is on offer. */
  identified: boolean;
  signedIn: boolean;
  onSignedIn: (v: boolean) => void;
  /** Start a new funnel (owners and admins). */
  onNew?: () => void;
}

const AUDIENCE = [
  { value: 'signed-in', label: 'Signed in' },
  { value: 'all', label: 'All visits' },
];

/** The funnel chart, its "Biggest drop" sentence and, at Controls, the per-release split. */
export function FunnelCard({ stack, days, funnels, selected, onPick, view, identified, signedIn, onSignedIn, onNew }: FunnelCardProps): React.JSX.Element {
  const v = view.data;
  const audience = v?.audience === 'signed-in' ? 'signed-in visitors' : identified ? 'all visits' : 'visits · cookieless';
  return (
    <section className="calm-card shadow-none flex min-w-0 flex-col gap-3 p-5" aria-label={funnelTitle(selected.name)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold">{funnelTitle(selected.name)}</h2>
        <span className="text-muted-foreground text-xs">{audience}</span>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">last {days} days</span>
      </div>
      <Depth at="controls">
        <div className="flex flex-wrap items-center gap-2">
          {funnels.length > 1 ? (
            <Segmented label="Funnel" value={selected.id} options={funnels.map((f) => ({ value: f.id, label: f.name }))} onChange={onPick} />
          ) : null}
          {identified ? (
            <Segmented label="Who to count" value={signedIn ? 'signed-in' : 'all'} options={AUDIENCE} onChange={(a) => onSignedIn(a === 'signed-in')} />
          ) : null}
          {onNew && funnels.length < MAX_FUNNELS ? (
            <button type="button" onClick={onNew} className="border-border hover:bg-accent ml-auto inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold pointer-coarse:min-h-11">
              <PlusIcon className="size-3.5" aria-hidden /> New funnel
            </button>
          ) : null}
        </div>
      </Depth>
      {view.isPending ? (
        <div aria-hidden className="flex flex-col gap-2">
          {selected.steps.map((_, i) => (
            <div key={i} className="shimmer-line h-8 rounded" style={{ width: `${100 - i * 12}%` }} />
          ))}
        </div>
      ) : view.isError ? (
        <ErrorState title="Couldn’t read this funnel." error={view.error} retry={() => void view.refetch()} retrying={view.isFetching} />
      ) : v && v.status !== 'ok' ? (
        <p className="text-muted-foreground py-2 text-sm">
          {v.status === 'unreachable' ? 'The analytics store isn’t answering right now.' : 'Analytics needs the observability store on to count a funnel.'}
        </p>
      ) : v ? (
        <>
          <FunnelChart view={v} />
          {v.steps[0]?.visitors === 0 ? (
            <p className="text-muted-foreground text-sm">No one reached {v.steps[0].name} in the last {days} days.</p>
          ) : null}
          <FunnelDrop stack={stack} view={v} />
          <Depth at="controls">
            <FunnelReleases view={v} />
          </Depth>
        </>
      ) : null}
    </section>
  );
}
