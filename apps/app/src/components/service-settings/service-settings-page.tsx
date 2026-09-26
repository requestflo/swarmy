import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ServerCrashIcon, TerminalIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { CalmPage, Depth, Say, SayHeader, type Crumb } from '@/components/calm';
import { serviceRole } from '@/components/canvas/service-role';
import { HeaderSkeleton } from '@/components/states';
import { RegionPlanEditor } from '@/components/services/region-plan-editor';
import { ServiceSecretVarsCard } from '@/components/services/service-secret-vars-card';
import { RemovePartRow } from './remove-part-row';
import { SettingsApplyBar } from './settings-apply-bar';
import { SettingsBody } from './settings-body';
import { SettingsCode } from './settings-code';
import { SleepRow } from './sleep-row';
import { serviceTone, shortName, SourcePill } from './settings-pills';
import { useServiceSettings } from './use-service-settings';
import { useSettingsDraft } from './use-settings-draft';

/** "api is running 2 of 2 copies." — the clause that matters coloured. */
function Headline({ name, running, desired, tone }: { name: string; running: number; desired: number; tone: ReturnType<typeof serviceTone> }): React.JSX.Element {
  if (desired === 0) return <>{name} is stopped on purpose.</>;
  const clause = `running ${running} of ${desired} ${desired === 1 ? 'copy' : 'copies'}.`;
  return tone === 'ok' || tone === 'idle' ? (
    <>
      {name} is {clause}
    </>
  ) : (
    <>
      {name} is <Say tone={tone}>{clause}</Say>
    </>
  );
}

/**
 * `/services/$serviceId` — the settings panel's content as a calm page: the
 * sentence header, Logs (the app's Logs tab), the same sections, and the
 * live compose in the aside at Code.
 */
export function ServiceSettingsPage({ serviceId }: { serviceId: string }): React.JSX.Element {
  const data = useServiceSettings(serviceId);
  const s = data.service;
  const d = useSettingsDraft(serviceId, data.spec, s?.replicas.desired ?? 0);
  const stack = s?.stackId ?? null;
  const name = s ? shortName(s.name, stack) : 'part';
  const crumbs: Crumb[] = [
    { label: 'Apps', to: '/' },
    ...(stack ? [{ label: stack, to: '/stacks/$name', params: { name: stack } }] : []),
    { label: name },
  ];

  if (s === null || (!s && !data.isPending)) {
    return (
      <CalmPage crumbs={crumbs}>
        <EmptyState
          icon={<ServerCrashIcon />}
          title="That part isn't here"
          description="It may have been removed, or the link is stale."
          action={<Button asChild variant="outline"><Link to="/">Back to apps</Link></Button>}
        />
      </CalmPage>
    );
  }

  const aside = s && data.spec ? (
    <Depth at="code">
      <div className="calm-card px-4 py-4">
        <SettingsCode short={name} serviceId={serviceId} spec={data.spec} draft={d.draft} git={data.git} />
      </div>
    </Depth>
  ) : undefined;

  return (
    <CalmPage crumbs={crumbs} aside={aside}>
      {s ? (
        <SayHeader
          eyebrow={stack ? `Part of ${stack}` : 'Part'}
          title={<Headline name={name} running={s.replicas.running} desired={s.replicas.desired} tone={serviceTone(s)} />}
          lede={
            <>
              {serviceRole({ name: s.name, image: s.image, labels: {} })}. Change how it runs below; nothing happens until you apply.{' '}
              <SourcePill git={data.git} stack={stack} name={s.name} />
            </>
          }
          actions={
            <>
              {stack ? (
                <Button asChild variant="outline" className="pointer-coarse:min-h-11">
                  <Link to="/stacks/$name/observability" params={{ name: stack }}>Logs</Link>
                </Button>
              ) : null}
              <Depth at="controls">
                <Button asChild variant="ghost" className="pointer-coarse:min-h-11">
                  <Link to="/services/$serviceId/terminal" params={{ serviceId }}>
                    <TerminalIcon aria-hidden className="size-4" /> Terminal
                  </Link>
                </Button>
              </Depth>
            </>
          }
        />
      ) : (
        <HeaderSkeleton />
      )}
      <div className="calm-card px-5 py-1">
        <SettingsBody data={data} d={d} />
        {s ? (
          <Depth at="controls">
            <SleepRow service={s} />
            <RemovePartRow serviceId={serviceId} name={name} stack={stack} />
          </Depth>
        ) : null}
      </div>
      {s ? (
        <Depth at="controls">
          <ServiceSecretVarsCard serviceId={serviceId} />
          {/* Renders nothing when the swarm has no regions in play. */}
          <RegionPlanEditor serviceId={serviceId} />
        </Depth>
      ) : null}
      <SettingsApplyBar d={d} className="calm-card sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 rounded-xl border lg:bottom-4" />
    </CalmPage>
  );
}
