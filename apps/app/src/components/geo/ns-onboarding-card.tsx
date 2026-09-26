import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CopyButton, cn } from '@swarmy/ui';
import type { DnsZoneView } from './geo-types';
import { NsNodePicker } from './ns-node-picker';
import { DelegationCheck } from './delegation-check';

interface NsOnboardingCardProps {
  zone: DnsZoneView;
  nodes: NodeSummary[];
}

/**
 * The hero: make swarmy THE nameserver for this zone. Pin 2–4 nodes, hand the
 * ns hostnames + glue IPs to the registrar, then verify delegation live.
 */
export function NsOnboardingCard({ zone, nodes }: NsOnboardingCardProps): React.JSX.Element {
  const eligible = nodes.filter((n) => n.ingress && n.outlet && n.region && n.publicIp);

  return (
    <Card className="calm-card">
      <CardHeader>
        <CardTitle className="text-base">
          Nameservers for <span className="mono-data">{zone.zone}</span>
        </CardTitle>
        <CardDescription>
          Pin 2–4 ingress+outlet nodes — they become <span className="mono-data">ns1…nsN</span> and
          answer DNS for this zone from every region.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <NsNodePicker zone={zone} eligible={eligible} />

        <div className="space-y-4">
          {zone.nameservers.length > 0 ? (
            <div>
              <p className="mono-label text-muted-foreground mb-2">At your registrar</p>
              <div className="border-border divide-border divide-y rounded-xl border">
                {zone.nameservers.map((ns) => (
                  <div key={ns.label} className="flex items-center gap-3 px-4 py-2.5">
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        ns.online ? 'bg-status-online' : 'bg-status-offline',
                      )}
                    />
                    <span className="mono-data min-w-0 flex-1 truncate font-medium">{ns.fqdn}</span>
                    <CopyButton value={ns.fqdn} className="size-7" />
                    <span className="mono-data text-muted-foreground w-32 truncate text-right">
                      {ns.ip || '—'}
                    </span>
                    {ns.ip ? <CopyButton value={ns.ip} className="size-7" /> : null}
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Add these as <strong>custom nameservers with glue/host records</strong> at your
                registrar (the IP is the glue). Delegation changes can take hours to propagate.
              </p>
              {zone.zone.split('.').length > 2 ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  A sub-zone like <span className="mono-data">{zone.zone}</span> is delegated from its parent&rsquo;s DNS
                  instead: add an <span className="mono-data">NS</span> record for{' '}
                  <span className="mono-data">{zone.zone.split('.')[0]}</span> per nameserver above, plus an{' '}
                  <span className="mono-data">A</span> (glue) record for each <span className="mono-data">nsN</span> name.
                </p>
              ) : null}
              <p className="text-muted-foreground mt-1 text-xs">
                Once delegated, swarmy answers ACME DNS-01 challenges itself — wildcard certificates like{' '}
                <span className="mono-data">*.{zone.zone}</span> need no DNS provider account or API token.
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Self-managed nodes: free port 53 from systemd-resolved first —{' '}
                <span className="mono-data">DNSStubListener=no</span> in{' '}
                <span className="mono-data">/etc/systemd/resolved.conf</span>.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Pick your nameserver nodes on the left — registrar instructions appear here.
            </p>
          )}

          <DelegationCheck zoneId={zone.id} hasNameservers={zone.nameservers.length > 0} />
        </div>
      </CardContent>
    </Card>
  );
}
