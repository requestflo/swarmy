import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { Depth, Section, Tech } from '@/components/calm';
import { Segmented } from '@/components/domains/segmented';
import { useTRPC } from '@/integrations/trpc';
import type { DnsZoneView } from './geo-types';
import { LocationPicks, SOURCE_WORDS, type GeoipSource } from './location-picks';

/** What `geodns.updateZone` accepts: 10–120 s. These are the three worth picking. */
const TTLS = [30, 60, 120] as const;
const TTL_HINT: Record<number, string> = {
  30: 'fastest to move visitors off a down front door · the default',
  60: 'half the queries, a little slower to move',
  120: 'fewest queries, slowest to move',
};

interface GeoConfig {
  geoipSource: GeoipSource;
  maxmindLicenseSecretRef?: string;
  mmdbConfigRef?: string;
}

/** Steering: how long answers last (the zone TTL) and where visitor locations come from. */
export function SteeringSection({ zone, config }: { zone: DnsZoneView; config: GeoConfig | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const update = useMutation(
    trpc.geodns.updateZone.mutationOptions({
      onSuccess: (z) => {
        toast.success(`Answers for ${z.zone} now last ${z.ttl} s`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const ttl = zone.ttl;
  const options = [...new Set<number>([...TTLS, ttl])].sort((a, b) => a - b);
  const source = config?.geoipSource ?? 'dbip';
  return (
    <Section title="Steering">
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Visitors ask again every {ttl} seconds, so when a front door goes down they move to the next one within about that long.{' '}
        {source === 'off' ? 'Locations are off, so every visitor gets the same order.' : `Locations come from ${SOURCE_WORDS[source]}.`}
      </p>
      <Depth at="controls">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold">Answer TTL</span>
          <Segmented
            label="Answer TTL"
            mono
            value={String(ttl)}
            disabled={update.isPending}
            options={options.map((t) => ({ value: String(t), label: `${t} s` }))}
            onChange={(v) => update.mutate({ id: zone.id, ttl: Number(v) })}
          />
          <span className="text-muted-foreground text-[11.5px]">{TTL_HINT[ttl] ?? 'a custom TTL'}</span>
        </div>
        <LocationPicks source={source} maxmindLicenseSecretRef={config?.maxmindLicenseSecretRef} mmdbConfigRef={config?.mmdbConfigRef} />
        <Tech>zone ttl {ttl}s (10–120) · health flips leave the answer within the reconcile tick (15 s) · unhealthy regions are omitted, none healthy → answer all</Tech>
      </Depth>
      {source !== 'off' ? (
        <span className="text-muted-foreground font-mono text-[10.5px]">
          IP geolocation by{' '}
          <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="underline underline-offset-2">DB-IP</a> (CC BY 4.0)
        </span>
      ) : null}
    </Section>
  );
}
