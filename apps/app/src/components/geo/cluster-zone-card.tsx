import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { Depth, Section, StatusWord, Tech, type Tone } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { ClusterZoneGlue } from './cluster-zone-glue';
import { DelegationCheck } from './delegation-check';
import type { ClusterZoneView, DnsZoneView } from './geo-types';

const WORD: Record<NonNullable<ClusterZoneView['source']>, { tone: Tone; word: string }> = {
  'cluster-zone': { tone: 'ok', word: 'swarmy answers app addresses' },
  'own-zone': { tone: 'ok', word: 'swarmy answers app addresses' },
  configured: { tone: 'info', word: 'your wildcard service' },
  'public-convenience': { tone: 'idle', word: 'public convenience name' },
};

/**
 * Cluster zone (plans/self-reliance.md B2b): the zone swarmy-dns answers app
 * addresses in itself — `<app>.<a-b-c-d>.<zone>`, plus `<a-b-c-d>.<zone>` by
 * synthesis — instead of sslip.io, which is labelled for what it is: a public
 * convenience name. Shows the registrar records and checks delegation.
 */
export function ClusterZoneCard({ zones }: { zones: DnsZoneView[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const view = useQuery(trpc.geodns.clusterZone.queryOptions());
  const set = useMutation(
    trpc.geodns.setClusterZone.mutationOptions({
      onSuccess: (v) => {
        toast.success(v.zone ? `Apps now get addresses under ${v.zone}` : 'Apps are back on their public convenience names');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const candidates = zones.filter((z) => z.mode === 'swarmy-ns' && z.enabled);
  const [pick, setPick] = React.useState('');
  const chosen = pick || candidates[0]?.id || '';
  const v = view.data as ClusterZoneView | undefined;
  const zone = v?.zoneId ? zones.find((z) => z.id === v.zoneId) : undefined;
  const word = v?.source ? WORD[v.source] : null;

  return (
    <Section title="Cluster zone" action={word ? <StatusWord tone={word.tone} word={word.word} /> : null}>
      {!v ? (
        <p className="text-muted-foreground text-[13.5px]">{view.isError ? view.error.message : 'Asking the controller…'}</p>
      ) : (
        <>
          <p className="text-muted-foreground text-[13.5px] leading-relaxed">
            {v.zone ? (
              <>Apps get addresses under <span className="text-foreground font-mono">{v.zone}</span>, and your own servers answer for them. No third party sits in the path.</>
            ) : v.source === 'configured' ? (
              <>Apps get addresses under <span className="text-foreground font-mono">{v.addressBase}</span>, the wildcard service you set. Pick a cluster zone and your own servers answer instead.</>
            ) : (
              <>Apps get a <strong className="text-foreground">public convenience name</strong> under sslip.io, a free service swarmy doesn&rsquo;t run. Pick a cluster zone and your own servers answer instead.</>
            )}
          </p>
          {v.addressBase ? (
            <p className="font-mono text-[12.5px]">
              <span className="text-muted-foreground">an app&rsquo;s address · </span>web-shop.{v.addressBase}
            </p>
          ) : null}
          {v.zone ? (
            <>
              {v.source === 'own-zone' ? (
                <p className="text-muted-foreground text-[13px]">App addresses in a zone is on, so apps use the shorter names there. {v.zone} still answers server addresses.</p>
              ) : null}
              <ClusterZoneGlue zone={v.zone} glue={v.glue} />
              {zone ? <DelegationCheck zoneId={zone.id} hasNameservers={zone.nameservers.length > 0} /> : null}
              <Tech>
                {`answers <a-b-c-d>.${v.zone} for ${v.synthesized.length} server${v.synthesized.length === 1 ? '' : 's'}${v.synthesized.length ? ` (${v.synthesized.join(', ')})` : ''} · IPv4 only · private and reserved ranges refused`}
              </Tech>
              <Depth at="controls">
                <div>
                  <Button variant="outline" size="sm" disabled={set.isPending} onClick={() => set.mutate({ id: v.zoneId!, enabled: false })}>
                    Stop using {v.zone}
                  </Button>
                </div>
              </Depth>
            </>
          ) : candidates.length ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Cluster zone"
                  value={chosen}
                  onChange={(e) => setPick(e.target.value)}
                  className="border-border bg-background h-9 min-w-44 rounded-[10px] border px-2.5 font-mono text-[13px] pointer-coarse:min-h-11"
                >
                  {candidates.map((z) => <option key={z.id} value={z.id}>{z.zone}</option>)}
                </select>
                <Button variant="outline" size="sm" disabled={!chosen || set.isPending} onClick={() => set.mutate({ id: chosen, enabled: true })}>
                  Use as cluster zone
                </Button>
              </div>
              <Tech>needs live NS delegation first · existing addresses move over on the next domain check · install-swarmy.sh --zone sets it at install</Tech>
            </>
          ) : (
            <p className="text-muted-foreground text-[13px]">Add a zone swarmy answers for at Controls, point it at your servers, then pick it here.</p>
          )}
        </>
      )}
    </Section>
  );
}
