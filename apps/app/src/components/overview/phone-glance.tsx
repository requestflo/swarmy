import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EstateUptimeView, NodeSummary } from '@swarmy/core';
import { Depth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { SayParts } from '@/components/apps/estate-say';
import type { AppItem } from '@/components/apps/use-apps';
import { DepthWelcomeCard } from './depth-welcome-card';
import { GlanceApps } from './glance-apps';
import { GlanceDoneCard } from './glance-done';
import { GlanceIncident } from './glance-incident';
import { GlanceVisits } from './glance-visits';
import { glanceDate } from './glance-words';
import { OverviewCode } from './overview-code';
import { OverviewHeader } from './overview-header';
import { OverviewNext, pickNext } from './overview-next';
import { useGlanceActions, type GlanceDone } from './use-glance-actions';
import type { OverviewSignals } from './use-overview-signals';
import type { ServerGlance } from './use-servers-glance';

/** A failed uptime read says "not enough data", never a guess. */
const notEnough: EstateUptimeView = { state: 'not-enough-data', pct: null, source: null, windowDays: 30, coveredHours: 0, downMinutes: null };

/**
 * The Overview on a phone (board 21, below lg): workspace and date, the
 * estate sentence, visits a minute and 30-day uptime with the servers as
 * dots, the open incident with swarmy's best guess, who has it and Put back /
 * Ack inline (or the next action when nothing is open), then the apps as
 * one-line rows.
 */

export function PhoneGlance({
  say,
  apps,
  sig,
  servers,
  nodes,
}: {
  say: SayParts;
  apps: AppItem[];
  sig: OverviewSignals;
  servers: ServerGlance[];
  nodes: NodeSummary[];
}): React.JSX.Element {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 30_000 });
  const uptime = useQuery({ ...trpc.estate.uptime.queryOptions(), refetchInterval: 5 * 60_000 });
  const [done, setDone] = React.useState<GlanceDone | null>(null);
  const actions = useGlanceActions(setDone);
  const incident = sig.openIncidents[0];
  const next = incident ? null : pickNext([], sig.firing, apps, nodes);
  const eyebrow = [org.data?.name, glanceDate(new Date())].filter(Boolean).join(' · ');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-5 pb-4">
      <OverviewHeader say={say} eyebrow={eyebrow} size="md" />
      <GlanceVisits traffic={traffic.data} uptime={uptime.isError ? notEnough : uptime.data} servers={servers} />
      {done && (!incident || done.incidentId === incident.id) ? (
        <GlanceDoneCard done={done} busy={actions.busy} onUndo={() => done.kind === 'put-back' && done.suspect && actions.undo(done.suspect)} />
      ) : incident ? (
        <GlanceIncident incident={incident} firing={sig.firing} actions={actions} />
      ) : next ? (
        <OverviewNext next={next} />
      ) : null}
      <GlanceApps apps={apps} traffic={traffic.data} />
      <DepthWelcomeCard />
      <Depth at="code">
        <OverviewCode apps={apps} nodes={nodes} />
      </Depth>
    </div>
  );
}
