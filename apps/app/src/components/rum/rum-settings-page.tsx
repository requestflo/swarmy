import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { AlreadyOn, Depth, SayHeader } from '@/components/calm';
import { RumCode } from './rum-code';
import { CardSkeleton, ErrorState } from '@/components/states';
import { AnalyticsModeCard } from './analytics-mode-card';
import { ConsentCard } from './consent-card';
import { GdprDeleteUserCard } from './gdpr-delete-user-card';
import { KeepCard } from './keep-card';
import { LegalCard } from './legal-card';
import { MaskingCard } from './masking-card';
import { RecordingCard } from './recording-card';
import { RoutesCard } from './routes-card';
import { pct, type RumSettings } from './rum-shared';
import { useIsOrgAdmin, useRumSettings, useSaveRumSettings } from './use-rum';

/**
 * Replay & analytics settings for one app. Every change is a label on the
 * app's services that the edge reads — it applies on the next page view,
 * with no redeploy.
 */
export function RumSettingsPage({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useRumSettings(stack);
  const footprint = useQuery(trpc.rum.footprint.queryOptions({ stack }));
  const admin = useIsOrgAdmin();
  const { save } = useSaveRumSettings(stack);

  if (q.isPending) {
    return (
      <div className="pb-8">
        <div className="grid gap-4 lg:grid-cols-2">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={3} />
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="flex flex-col gap-4 pb-8">
        <SayHeader size="md" title="Couldn’t read these settings." />
        <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  const s = q.data.settings;
  const card = { settings: s, onChange: (patch: Partial<RumSettings>) => save(s, patch), disabled: !admin };

  const recording = s.enabled && s.mode === 'identified' && s.replaySampleRate > 0;
  const title = !s.enabled ? (
    <>Analytics and replay are off for {stack}.</>
  ) : (
    <>
      Analytics is on for {stack}, {s.mode === 'identified' ? 'with signed-in visitors' : 'cookieless'}.{' '}
      <em>{recording ? `Recording ${pct(s.replaySampleRate)} of signed-in visits.` : 'Nothing is recorded.'}</em>
    </>
  );
  return (
    <div className="flex flex-col gap-4 pb-8">
      <SayHeader size="md" title={title} lede="Every change is a label the edge reads. It applies on the next page view, with no redeploy." />
      <RumCode stack={stack} settings={s} routes={q.data.routes} />
      {!admin ? <p className="text-muted-foreground text-sm">Only owners and admins can change these settings.</p> : null}
      <Depth only="summary">
        <AlreadyOn
          title="How it’s set"
          items={[
            { what: 'Counting', detail: s.enabled ? (s.mode === 'identified' ? 'visits, sessions and signed-in users' : 'aggregate counts, no cookies, no personal data') : 'off' },
            { what: 'Recording', detail: recording ? `${pct(s.replaySampleRate)} of signed-in visits, inputs masked${s.maskAllText ? ', all text masked' : ''}` : 'off' },
            { what: 'Consent', detail: s.consent === 'none' ? 'not asked (identified mode needs it)' : s.consent === 'cmp' ? 'from your consent banner' : 'the app says when' },
            { what: 'Kept', detail: `${s.retentionDays} days, then deleted` },
            { what: 'Routes', detail: `${q.data.routes.filter((r) => r.injected).length} of ${q.data.routes.length} measured` },
          ]}
        />
      </Depth>
      <Depth at="controls">
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <div className="flex min-w-0 flex-col gap-4">
            <RecordingCard {...card} stores={q.data.stores} />
            <RoutesCard stack={stack} routes={q.data.routes} disabled={!admin} />
            <KeepCard {...card} footprint={footprint.data ?? undefined} />
            <MaskingCard {...card} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <AnalyticsModeCard stack={stack} {...card} />
            <ConsentCard {...card} />
            <LegalCard />
            <GdprDeleteUserCard stack={stack} disabled={!admin} />
          </div>
        </div>
      </Depth>
    </div>
  );
}
