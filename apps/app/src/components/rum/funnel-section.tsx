import * as React from 'react';
import { Button } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { FunnelCard } from './funnel-card';
import { FunnelEditor } from './funnel-editor';
import { starterFunnel } from './funnel-model';
import { useIsOrgAdmin } from './use-rum';
import { useFunnel, useFunnels } from './use-funnels';

interface FunnelSectionProps {
  stack: string;
  days: number;
  /** Identified mode: a funnel can count signed-in people only. */
  identified: boolean;
}

/**
 * The app's conversion funnel: the chart and its "Biggest drop" sentence at
 * every depth, the editor at Controls. With no funnel yet, the card offers
 * to add one (and the editor opens in place).
 */
export function FunnelSection({ stack, days, identified }: FunnelSectionProps): React.JSX.Element | null {
  const admin = useIsOrgAdmin();
  const funnels = useFunnels(stack);
  const list = funnels.data?.funnels ?? [];
  const [picked, setPicked] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [signedIn, setSignedIn] = React.useState(false);
  const selected = list.find((f) => f.id === picked) ?? list[0] ?? null;
  const view = useFunnel(stack, selected?.id ?? null, days, identified && signedIn);

  if (funnels.isPending) return <CardSkeleton lines={3} />;
  if (funnels.isError) return null;

  const onSaved = (id: string | null): void => {
    setCreating(false);
    setPicked(id);
  };
  const ids = list.map((f) => f.id);
  const editor = creating ? (
    <FunnelEditor key="new" stack={stack} funnels={list} initial={starterFunnel(ids)} isNew admin={admin} onSaved={onSaved} onCancel={() => setCreating(false)} />
  ) : selected ? (
    <Depth at="controls">
      <FunnelEditor key={selected.id} stack={stack} funnels={list} initial={selected} isNew={false} admin={admin} onSaved={onSaved} />
    </Depth>
  ) : null;

  return (
    <>
      {selected ? (
        <FunnelCard
          stack={stack}
          days={days}
          funnels={list}
          selected={selected}
          onPick={setPicked}
          view={view}
          identified={identified}
          signedIn={signedIn}
          onSignedIn={setSignedIn}
          onNew={admin ? () => setCreating(true) : undefined}
        />
      ) : !creating ? (
        <section className="calm-card shadow-none flex flex-wrap items-center gap-3 p-5" aria-label="Funnel">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-base font-bold">No funnel yet</h2>
            <span className="text-muted-foreground text-sm">
              List the pages a visitor passes through to buy or sign up, and see where they give up.
            </span>
          </span>
          {admin ? (
            <Button size="sm" variant="outline" className="rounded-full" onClick={() => setCreating(true)}>
              Add a funnel
            </Button>
          ) : null}
        </section>
      ) : null}
      {editor}
    </>
  );
}
