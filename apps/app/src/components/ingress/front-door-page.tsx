import * as React from 'react';
import { Button } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, CodeView, Depth, NextAction, Say } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { DRIVER_LABELS } from './driver-config';
import { DriverPanel, previewFiles } from './driver-panel';
import { FrontDoorControls } from './front-door-controls';
import { useFrontDoor } from './use-front-door';

/** /ingress — "Front door": is HTTPS on, what serves it, on how many servers. Knobs at Controls, the Caddyfile at Code. */
export function FrontDoorPage(): React.JSX.Element {
  const f = useFrontDoor();
  const c = f.config.data;
  if (f.config.error && !c) return <Pad><PageError error={f.config.error} retry={() => void f.config.refetch()} /></Pad>;
  if (!c || !f.domains.isSuccess) return <PageSkeleton variant="form" />;

  const label = DRIVER_LABELS[f.driver];
  const serving = c.runtime.serving;
  const n = f.domains.data.length;
  const servers = c.topology === 'edge-per-node' ? c.certStorage.edges : Math.max(1, c.runtime.runningTasks);
  const where = `${n} domain${n === 1 ? '' : 's'} on ${servers} server${servers === 1 ? '' : 's'}`;
  const title = serving ? (
    <>HTTPS on. <em>{label} serving {where}.</em></>
  ) : f.driver === 'none' ? (
    <>swarmy tracks {n} domain{n === 1 ? '' : 's'}. <em>Your own proxy serves them.</em></>
  ) : (
    <>
      <Say tone={c.runtime.state === 'paused' ? 'idle' : 'warn'}>The front door isn&apos;t serving.</Say> <em>{c.runtime.message}</em>
    </>
  );
  const problem = !serving && f.driver !== 'none';

  return (
    <Pad>
      <SectionHeader
        title={title}
        description="Every visitor comes in here first. It checks HTTPS, then hands the visit to the right app. Each app's addresses live on its Domains tab."
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {problem ? (
            <NextAction
              title={c.runtime.state === 'paused' ? 'The front door is paused' : 'The front door is not up yet'}
              tech={`runtime: ${c.runtime.state} · ${c.runtime.runningTasks}/${c.runtime.desiredTasks ?? '–'} tasks`}
              actions={
                c.runtime.state === 'paused' ? (
                  <Button onClick={() => f.setEnabled.mutate({ enabled: true })} disabled={f.setEnabled.isPending}>
                    Turn it on
                  </Button>
                ) : undefined
              }
            >
              {c.runtime.message}
            </NextAction>
          ) : null}
          {c.dashboardWarning ? (
            <NextAction tone="bad" title="The dashboard's https address isn't served">{c.dashboardWarning}</NextAction>
          ) : null}
          <Depth at="controls">
            <DriverPanel
              driver={f.driver}
              enabled={c.enabled}
              onDriverChange={(d) => f.setDriver.mutate({ driver: d })}
              onEnabledChange={(v) => f.setEnabled.mutate({ enabled: v })}
            />
            <FrontDoorControls f={f} />
          </Depth>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <CodeView
            tabs={[
              {
                label: f.driver === 'cloudflared' ? 'config.yml' : 'Caddyfile',
                code: f.preview.data ? `# ${f.preview.data.summary}\n${previewFiles(f.preview.data)}` : '# swarmy writes no routing config (None)',
              },
            ]}
            source="readonly"
            note="Read-only: the config swarmy renders for the front door right now. Change it with the settings on this page or each app's domains."
          />
          <AlreadyOn
            items={[
              { what: 'HTTPS', detail: f.driver === 'caddy' ? 'certificates issue and renew themselves' : 'handled by your proxy' },
              { what: 'Front door', detail: c.topology === 'edge-per-node' ? 'one on every ingress server' : 'one, shared by every app' },
              ...(c.tunnelConfigured ? [{ what: 'Tunnel', detail: 'visitors arrive through Cloudflare' }] : []),
              { what: 'Addresses', detail: `${n} across your apps`, to: '/network' },
            ]}
          />
        </aside>
      </div>
    </Pad>
  );
}

function Pad({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">{children}</div>;
}
