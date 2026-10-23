import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink, StatusWord, Tech, toneFromStatus } from '@/components/calm';
import { edgeTone } from '@/components/ingress/edge-runtime';
import { useTRPC } from '@/integrations/trpc';

const RUNTIME_LABEL: Record<string, string> = {
  paused: 'off',
  deploying: 'starting',
  down: 'down',
  degraded: 'degraded',
  serving: 'live',
};

/**
 * Geo-DNS on the Network hub: one sentence and the way to its own tab
 * (Network › Geo-DNS, board 32), where the map, records, delegation and every
 * control now live. Kept at its old place (`#geo-dns`) so links still land.
 */
export function GeoDnsSection(): React.JSX.Element {
  const trpc = useTRPC();
  const config = useQuery({ ...trpc.geodns.getConfig.queryOptions(), refetchInterval: 5000 });
  const zones = useQuery({ ...trpc.geodns.listZones.queryOptions(), refetchInterval: 10_000 });
  const enabled = !!config.data?.enabled;
  const runtime = config.data?.runtime;
  const swarmyZones = (zones.data ?? []).filter((z) => z.mode === 'swarmy-ns').length;
  return (
    <Section
      id="geo-dns"
      title="Nearest front door"
      hint="Geo-DNS"
      action={
        <>
          <StatusWord
            tone={enabled ? toneFromStatus(edgeTone(runtime?.state)) : 'idle'}
            word={enabled ? `DNS ${RUNTIME_LABEL[runtime?.state ?? 'deploying']}` : 'Off'}
          />
          <Link to="/network/geo-dns"><SectionLink>Geo-DNS →</SectionLink></Link>
        </>
      }
    >
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        {enabled
          ? `swarmy answers for ${swarmyZones} domain${swarmyZones === 1 ? '' : 's'} itself and sends each visitor to the closest healthy front door.`
          : 'Off. Every visitor goes to the same front door. Turn it on to answer for your domains and send visitors to the closest one.'}
      </p>
      {enabled && runtime && runtime.state !== 'serving' ? <p className="text-tone-warn text-[13px]">{runtime.message}</p> : null}
      <Tech>swarmy-dns on ingress+outlet servers · web records derive from routes · no zone files</Tech>
    </Section>
  );
}
