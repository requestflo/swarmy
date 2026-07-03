import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { DriverPanel } from '@/components/ingress/driver-panel';
import { CaddyHaCard } from '@/components/ingress/caddy-ha-card';
import { OnDemandTlsCard } from '@/components/ingress/on-demand-tls-card';
import { ControllerImageCard } from '@/components/ingress/controller-image-card';
import { TargetNodesCard } from '@/components/ingress/target-nodes-card';
import { CloudflareTunnelCard } from '@/components/ingress/cloudflare-tunnel-card';
import { ExternalAcmeNoticeCard } from '@/components/ingress/external-acme-notice-card';
import { DomainsList } from '@/components/ingress/domains-list';
import { GlobalGeoDnsFooter } from '@/components/geo/global-geodns-footer';
import { DRIVER_LABELS, type IngressDriverId } from '@/components/ingress/driver-config';

/** Global "Edge & ingress" page: fleet-wide edge config, not per-route detail. */
export const Route = createFileRoute('/_authed/ingress')({
  component: IngressPage,
});

function IngressPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.ingress.getConfig.queryOptions());
  const domains = useQuery(trpc.ingress.listDomains.queryOptions());
  const preview = useQuery({
    ...trpc.ingress.previewConfig.queryOptions({}),
    enabled: (config.data?.driver ?? 'none') !== 'none',
  });

  const invalidate = (): void => void qc.invalidateQueries();
  const setDriver = useMutation(
    trpc.ingress.setDriver.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const setEnabled = useMutation(
    trpc.ingress.setEnabled.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const setHaStorage = useMutation(
    trpc.ingress.setHaStorage.mutationOptions({
      onSuccess: () => {
        toast.success('Shared-cert storage updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setTunnel = useMutation(
    trpc.ingress.setTunnel.mutationOptions({
      onSuccess: () => {
        toast.success('Cloudflare tunnel updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setOnDemandTls = useMutation(
    trpc.ingress.setOnDemandTls.mutationOptions({
      onSuccess: () => {
        toast.success('On-demand TLS updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const driver = (config.data?.driver ?? 'none') as IngressDriverId;
  const isNone = driver === 'none';
  const enabled = !!config.data?.enabled;
  const live = enabled && !isNone;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Edge & ingress"
        title={
          <>
            The <em>edge</em>, configured once.
          </>
        }
        description="Driver, TLS, HA storage and the controller build — fleet-wide. Per-stack domains, routes and protections live on each stack's Network tab."
        actions={
          <StatusBadge
            tone={live ? 'online' : 'neutral'}
            label={live ? `${DRIVER_LABELS[driver]} · live` : isNone ? 'Tracking only' : 'Paused'}
          />
        }
      />

      <DriverPanel
        driver={driver}
        enabled={enabled}
        preview={preview.data}
        onDriverChange={(d) => setDriver.mutate({ driver: d })}
        onEnabledChange={(v) => setEnabled.mutate({ enabled: v })}
      />

      {driver === 'caddy' ? (
        <>
          <CaddyHaCard
            haConfigured={!!config.data?.haConfigured}
            onEnable={(host) => setHaStorage.mutate({ host })}
            onDisable={() => setHaStorage.mutate(null)}
            pending={setHaStorage.isPending}
          />
          <OnDemandTlsCard
            onSave={(askUrl) => setOnDemandTls.mutate({ enabled: true, askUrl })}
            onDisable={() => setOnDemandTls.mutate({ enabled: false })}
            pending={setOnDemandTls.isPending}
          />
          <ControllerImageCard image={config.data?.controllerImage ?? null} />
          <TargetNodesCard targetNodes={config.data?.targetNodes ?? []} />
        </>
      ) : null}

      {driver === 'cloudflared' ? (
        <CloudflareTunnelCard
          configured={!!config.data?.tunnelConfigured}
          onSave={(v) => setTunnel.mutate(v)}
          onClear={() => setTunnel.mutate(null)}
          pending={setTunnel.isPending}
        />
      ) : null}

      {driver === 'nginx' || driver === 'haproxy' ? <ExternalAcmeNoticeCard driver={driver} /> : null}

      <DomainsList domains={domains.data ?? []} />

      <GlobalGeoDnsFooter />
    </div>
  );
}
