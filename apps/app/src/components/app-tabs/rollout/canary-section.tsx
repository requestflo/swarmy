import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { InvService } from '@swarmy/core';
import { Section } from '@/components/calm';
import { Segmented, type SegOption } from '@/components/service-settings/settings-row';
import { useTRPC } from '@/integrations/trpc';
import { CanaryStartRow } from './canary-start-row';
import { ErrorWeekChart } from './error-week-chart';
import { SplitDiagram } from './split-diagram';
import { useErrorWeek } from './use-error-week';

const PCTS: SegOption<number>[] = [5, 10, 25, 50].map((p) => ({ value: p, label: `${p}%` }));
const TRIPS: SegOption<number>[] = [2, 3, 5].map((p) => ({ value: p, label: `${p}%` }));
const copies = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;
const tagOf = (image: string): string => image.slice(image.lastIndexOf(':') + 1) || image;

/**
 * "Try it on a slice of visitors first" (board AppRollout): the share chips,
 * the split as a diagram with the app's visitors a second, the error ceiling
 * replayed over the week, and starting it. A canary already in flight shows
 * its live split and points at Releases, where it's watched.
 */
export function CanarySection({ stack, inv, name, address }: { stack: string; inv: InvService; name: string; address: string | null | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 15_000 });
  const canaries = useQuery({ ...trpc.releases.canaryStatus.queryOptions({ stack }), refetchInterval: 10_000 });
  const live = canaries.data?.find((c) => c.service === inv.name || c.service === `${stack}_${name}`);
  const [pct, setPct] = React.useState(10);
  const [trip, setTrip] = React.useState(5);
  const [windowMin, setWindowMin] = React.useState(15);
  const week = useErrorWeek(stack, name);
  const share = live?.trafficPct ?? pct;
  const app = traffic.data?.apps.find((a) => a.app === stack);
  const rate = app ? `${Math.round((app.requestsPerMin / 60) * 10) / 10} req/s${app.hosts.length > 1 ? ` across ${app.hosts.length} addresses` : ''}` : null;
  return (
    <Section title="Try it on a slice of visitors first" hint="canary">
      {live ? (
        <p className="text-[13.5px]">
          A canary of {name} is live: {tagOf(live.canaryImage)} gets {live.trafficPct}% of visitors for {live.remainingMin} more min.{' '}
          <Link to="/stacks/$name/releases" params={{ name: stack }} className="text-primary underline-offset-2 hover:underline">
            Watch or stop it on Releases →
          </Link>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-muted-foreground text-[12.5px]">The new version gets</span>
          <Segmented label="Share of visitors for the new version" options={PCTS} value={pct} onChange={setPct} mono />
        </div>
      )}
      {address ? (
        <SplitDiagram
          door={address}
          doorSub={rate}
          pct={share}
          stable={{ title: `${name} · ${tagOf(live?.stableImage ?? inv.image)}`, sub: `${100 - share}% · ${copies(inv.replicas.desired)}` }}
          canary={{ title: live ? `${name}--canary · ${tagOf(live.canaryImage)}` : `${name}--canary · new version`, sub: `${share}% · 1 copy · no address of its own` }}
        />
      ) : address === null ? (
        <p className="text-muted-foreground text-[13px]">
          {name} has no address, so a canary runs beside it without visitors of its own: swarmy only watches whether it stays up.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground text-[12.5px]">Put it back if errors pass</span>
        <Segmented label="Error ceiling" options={TRIPS} value={live?.rollbackOnErrorRatePct ?? trip} onChange={setTrip} mono disabled={!!live} />
      </div>
      <ErrorWeekChart week={week} tripPct={live?.rollbackOnErrorRatePct ?? trip} windowMin={live?.durationMin ?? windowMin} />
      {live || canaries.isPending ? null : (
        <CanaryStartRow stack={stack} service={inv.name} name={name} currentImage={inv.image} pct={pct} tripPct={trip} windowMin={windowMin} onWindow={setWindowMin} />
      )}
    </Section>
  );
}
