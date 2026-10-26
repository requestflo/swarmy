import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTRPC } from '@/integrations/trpc';
import { PgSwitchoverConfirm } from '@/components/pgdetail/pg-switchover-confirm';
import { PgSwitchoverProgress } from '@/components/pgdetail/pg-switchover-progress';
import type { PgDetailCluster } from '@/components/pgdetail/use-pg-detail';
import { usePgSwitchover } from '@/components/pgdetail/use-pg-switchover';
import { useMemberServers } from '@/components/stack-data/use-member-servers';
import { DataPgChip } from './data-pg-chip';
import { STANDBY_STAYS, copyChips, writerDragKey, type CopyChip } from './pg-copies-model';

/**
 * One managed Postgres on board 15: its copies by server. Dropping the
 * writer on a standby copy (or picking the standby) offers the planned
 * switchover first — "Make wkr-2's copy the writer, then move?" — with the
 * shared plan's answer; standby copies are never moved, and dragging one
 * says so. A switchover in flight shows its progress here too.
 */
export function DataPgStrip({ stack, cluster }: { stack: string; cluster: string }): React.JSX.Element {
  const trpc = useTRPC();
  const db = useQuery({ ...trpc.db.get.queryOptions({ stack }), refetchInterval: 10_000 });
  const c = ((db.data?.clusters ?? []) as PgDetailCluster[]).find((x) => x.name === cluster) ?? null;
  const place = useMemberServers(`${stack}_${cluster}-`, !!c);
  const [offer, setOffer] = React.useState<CopyChip | null>(null);
  const [note, setNote] = React.useState(false);
  const sw = usePgSwitchover(stack, c, place.byService, offer !== null);
  const chips = c ? copyChips(c.members, place.byService) : [];
  const hasStandby = chips.some((x) => x.role === 'standby');
  const pick = (chip: CopyChip) => {
    setNote(false);
    setOffer(chip);
  };
  return (
    <li className="flex flex-col gap-2 border-b py-2.5 last:border-b-0" aria-label={`${stack}’s ${cluster} database: where its copies run`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link to="/stacks/$name/data/$cluster" params={{ name: stack, cluster }} className="mr-1 min-w-[9rem] text-[13.5px] font-semibold hover:underline">
          {stack} · {cluster}
        </Link>
        {!c ? (
          <span className="text-muted-foreground text-[12.5px]">{db.isPending ? 'Reading its copies…' : 'Not running right now.'}</span>
        ) : (
          chips.map((chip) => (
            <DataPgChip
              key={chip.key}
              chip={chip}
              dragKey={writerDragKey(stack, cluster)}
              canDrag={hasStandby && !sw.running}
              onOffer={pick}
              onStandbyDrag={() => setNote(true)}
            />
          ))
        )}
        {c && !hasStandby ? <span className="text-muted-foreground text-[12.5px]">One copy: add a standby copy first, then the writer can move to it.</span> : null}
      </div>
      {note ? (
        <p role="status" className="text-muted-foreground text-[12.5px]">
          {STANDBY_STAYS}
        </p>
      ) : null}
      {offer && c ? (
        <PgSwitchoverConfirm
          question={`Make ${offer.server ? `${offer.server}'s copy` : sw.copyName(offer.service)} the writer, then move?`}
          plan={sw.plan(offer.service)}
          copyName={sw.copyName}
          readError={sw.readError}
          starting={sw.starting}
          onConfirm={() => {
            sw.start(offer.service);
            setOffer(null);
          }}
          onCancel={() => setOffer(null)}
        />
      ) : null}
      {sw.run ? <PgSwitchoverProgress run={sw.run} copyName={sw.copyName} /> : null}
    </li>
  );
}
