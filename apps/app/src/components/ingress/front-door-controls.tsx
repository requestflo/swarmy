import * as React from 'react';
import { OnDemandTlsCard } from './on-demand-tls-card';
import { ControllerImageCard } from './controller-image-card';
import { TargetNodesCard } from './target-nodes-card';
import { TopologyCard } from './topology-card';
import { CloudflareTunnelCard } from './cloudflare-tunnel-card';
import { WildcardCertsCard } from './wildcard-certs-card';
import type { useFrontDoor } from './use-front-door';

/** The Front door's Controls depth: every existing knob, unchanged, per proxy. */
export function FrontDoorControls({ f }: { f: ReturnType<typeof useFrontDoor> }): React.JSX.Element | null {
  const c = f.config.data;
  if (!c) return null;
  if (f.driver === 'cloudflared') {
    return (
      <CloudflareTunnelCard
        configured={!!c.tunnelConfigured}
        onSave={(v) => f.setTunnel.mutate(v)}
        onClear={() => f.setTunnel.mutate(null)}
        pending={f.setTunnel.isPending}
      />
    );
  }
  if (f.driver !== 'caddy') return null;
  return (
    <>
      <TopologyCard topology={c.topology ?? 'controller'} certStorage={c.certStorage} />
      {c.topology === 'edge-per-node' ? null : <TargetNodesCard targetNodes={c.targetNodes ?? []} />}
      <OnDemandTlsCard
        onSave={(askUrl) => f.setOnDemandTls.mutate({ enabled: true, askUrl })}
        onDisable={() => f.setOnDemandTls.mutate({ enabled: false })}
        pending={f.setOnDemandTls.isPending}
      />
      <WildcardCertsCard />
      <ControllerImageCard image={c.controllerImage ?? null} defaultImage={c.defaultControllerImage ?? null} />
    </>
  );
}
