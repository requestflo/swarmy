import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth, Say } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { caddyfileOf, onDemandOf } from './caddyfile-text';
import { CloudflareTunnelCard } from './cloudflare-tunnel-card';
import { DRIVER_LABELS } from './driver-config';
import { DriverPanel } from './driver-panel';
import { EdgeServersSection } from './edge/edge-servers-section';
import { HttpsSection } from './edge/https-section';
import { TopologySection } from './edge/topology-section';
import { FrontDoorCode } from './front-door-code';
import { FrontDoorControls } from './front-door-controls';
import { FrontDoorNext } from './front-door-next';
import { useFrontDoor } from './use-front-door';
import { useIsAdmin } from './use-is-admin';

/** /ingress — board 31: the edge topology that morphs, which servers are edges, HTTPS. Knobs at Controls, the Caddyfile at Code. */
export function FrontDoorPage(): React.JSX.Element {
  const f = useFrontDoor();
  const trpc = useTRPC();
  const geo = useQuery(trpc.geodns.getConfig.queryOptions());
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 15_000 });
  const admin = useIsAdmin();
  const [tunnel, setTunnel] = React.useState(false);
  const tunnelRef = React.useRef<HTMLDivElement>(null);
  const c = f.config.data;
  if (f.config.error && !c) return <Pad><PageError error={f.config.error} retry={() => void f.config.refetch()} /></Pad>;
  if (!c || !f.domains.isSuccess) return <PageSkeleton variant="form" />;

  const label = DRIVER_LABELS[f.driver];
  const caddy = f.driver === 'caddy';
  const perNode = c.topology === 'edge-per-node';
  const n = f.domains.data.length;
  const servers = perNode ? c.certStorage.edges : Math.max(1, c.runtime.runningTasks);
  const where = `${n} domain${n === 1 ? '' : 's'} on ${servers} server${servers === 1 ? '' : 's'}`;
  const title = c.runtime.serving ? (
    <>HTTPS on. <em>{label} serving {where}.</em></>
  ) : f.driver === 'none' ? (
    <>swarmy tracks {n} domain{n === 1 ? '' : 's'}. <em>Your own proxy serves them.</em></>
  ) : (
    <>
      <Say tone={c.runtime.state === 'paused' ? 'idle' : 'warn'}>The front door isn&apos;t serving.</Say> <em>{c.runtime.message}</em>
    </>
  );
  const onDemand = caddy && f.preview.data ? onDemandOf(caddyfileOf(f.preview.data)) : null;
  const geoOn = !!geo.data?.runtime?.serving;
  const openTunnel = (): void => {
    setTunnel(true);
    requestAnimationFrame(() => tunnelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <Pad>
      <SectionHeader
        title={title}
        description="Every visitor comes in here first. It checks HTTPS, then hands the visit to the right app. Each app's addresses live on its Domains tab."
      />
      <div className="mb-5 flex flex-col gap-5">
        <FrontDoorNext f={f} />
        {caddy ? (
          <TopologySection
            current={c.topology}
            nodes={nodes.data}
            targetNodes={c.targetNodes}
            geo={geoOn}
            apps={[...new Set(f.domains.data.map((d) => d.stack))]}
            bucket={c.certStorage.bucket}
            objectStorage={c.certStorage.objectStorageEnabled}
            sharedCertsPending={c.certStorage.mode !== 'shared'}
            admin={admin}
          />
        ) : null}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {caddy ? (
            <>
              <EdgeServersSection perNode={perNode} geo={geoOn} targetNodes={c.targetNodes} admin={admin} onTunnel={openTunnel} />
              <HttpsSection
                serving={c.runtime.serving}
                shared={c.certStorage.mode === 'shared'}
                bucket={c.certStorage.bucket}
                domains={f.domains.data}
                onDemand={onDemand}
                admin={admin}
                pending={f.setOnDemandTls.isPending}
                onSetOnDemand={(v) => f.setOnDemandTls.mutate(v)}
              />
            </>
          ) : null}
          {f.driver === 'cloudflared' || tunnel || c.tunnelConfigured ? (
            <div ref={tunnelRef} className="scroll-mt-6">
              <CloudflareTunnelCard configured={!!c.tunnelConfigured} onSave={(v) => f.setTunnel.mutate(v)} onClear={() => f.setTunnel.mutate(null)} pending={f.setTunnel.isPending} />
            </div>
          ) : null}
          <Depth at="controls">
            <DriverPanel driver={f.driver} enabled={c.enabled} onDriverChange={(d) => f.setDriver.mutate({ driver: d })} onEnabledChange={(v) => f.setEnabled.mutate({ enabled: v })} />
            <FrontDoorControls f={f} />
          </Depth>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <FrontDoorCode driver={f.driver} preview={f.preview.data} topology={c.topology} edgeId={nodes.data?.find((x) => x.ingress)?.id ?? null} ask={onDemand?.ask ?? null} />
          <AlreadyOn
            items={[
              { what: 'HTTPS', detail: caddy ? 'certificates issue and renew themselves' : 'handled by your proxy' },
              { what: 'Front door', detail: perNode ? 'one on every edge server' : 'one, shared by every app' },
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
