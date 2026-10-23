import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, cn } from '@swarmy/ui';
import { Section, StatusWord, Tech, type Tone } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import type { DnsZoneView } from './geo-types';

const COUNT = ['no', 'one', 'two', 'three', 'four'];

/**
 * Delegation (board 32): the servers the registrar points the zone at, and
 * the live check — the parent's NS set, then a direct SOA query to each glue
 * address (`geodns.checkDelegation`). It runs once on open; Check again re-asks.
 */
export function DelegationSection({ zone }: { zone: DnsZoneView }): React.JSX.Element {
  const trpc = useTRPC();
  const ns = zone.nameservers;
  const check = useQuery({
    ...trpc.geodns.checkDelegation.queryOptions({ id: zone.id }),
    enabled: zone.mode === 'swarmy-ns' && ns.length >= 2,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const d = check.data;
  const answering = d?.nameservers.filter((n) => n.reachable && n.serialMatches).length ?? 0;
  const word: { tone: Tone; word: string } = check.isFetching
    ? { tone: 'info', word: 'checking…' }
    : check.isError
      ? { tone: 'idle', word: 'couldn’t check' }
      : !d
        ? { tone: 'idle', word: 'not checked' }
        : !d.delegated
          ? { tone: 'warn', word: 'not delegated yet' }
          : answering === d.nameservers.length
            ? { tone: 'ok', word: `delegated · ${d.nameservers.length === 2 ? 'both' : 'all'} answer` }
            : { tone: 'warn', word: `delegated · ${answering} of ${d.nameservers.length} answer` };

  if (zone.mode !== 'swarmy-ns') {
    return (
      <Section title="Delegation">
        <p className="text-muted-foreground text-[13.5px]">{zone.zone} stays with its own DNS provider. swarmy keeps its web records in step there, so there is nothing to point at swarmy.</p>
      </Section>
    );
  }
  if (ns.length < 2) {
    return (
      <Section title="Delegation" action={<StatusWord tone="warn" word="no nameservers yet" />}>
        <p className="text-muted-foreground text-[13.5px]">Pick two to four of your front doors to answer for {zone.zone}. Your registrar then points the domain at them, once.</p>
      </Section>
    );
  }
  return (
    <Section title="Delegation" action={<StatusWord tone={word.tone} word={word.word} pulse={check.isFetching} />}>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        {d && !d.delegated
          ? `Point ${zone.zone} at these ${COUNT[ns.length] ?? ns.length} servers at your registrar, with their addresses as glue.`
          : `Your registrar points ${zone.zone} at these ${COUNT[ns.length] ?? ns.length} servers.`}{' '}
        Adding or removing other front doors never touches the registrar.
      </p>
      <div className="flex flex-col">
        {ns.map((n) => {
          const r = d?.nameservers.find((x) => x.fqdn === n.fqdn);
          return (
            <div key={n.fqdn} className="border-border flex min-h-10 flex-wrap items-center gap-x-3 gap-y-0.5 border-b py-1.5 font-mono text-[12px] last:border-b-0">
              <span className="min-w-0 font-semibold">{n.fqdn}</span>
              <span className="text-muted-foreground flex-1 text-[11.5px] whitespace-nowrap">glue {n.ip || '—'}</span>
              <Mark ok={d ? d.publicNs.includes(n.fqdn) : null} label="NS" />
              <Mark ok={r ? r.reachable && r.serialMatches : null} label="SOA" />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="outline" size="sm" disabled={check.isFetching} onClick={() => void check.refetch()}>
          {d ? 'Check again' : 'Check delegation'}
        </Button>
        <span className="text-muted-foreground font-mono text-[11px]">
          {d ? `checked ${relTime(new Date(check.dataUpdatedAt))} · registrar changes can take hours` : check.isFetching ? 'asking the registry and each glue address…' : ''}
        </span>
      </div>
      {check.isError ? <Tech>{check.error.message}</Tech> : null}
      {d && !d.delegated && d.publicNs.length ? <Tech>the registry answers NS {d.publicNs.join(', ')}</Tech> : null}
      <Tech>zone serial {zone.serial} · SOA ✓ = glue address answers authoritatively with this serial</Tech>
    </Section>
  );
}

function Mark({ ok, label }: { ok: boolean | null; label: string }): React.JSX.Element {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', ok === null ? 'bg-muted text-muted-foreground' : ok ? 'bg-status-online/15 text-tone-ok' : 'bg-status-warning/15 text-tone-warn')}>
      {label} {ok === null ? '…' : ok ? '✓' : '✗'}
    </span>
  );
}
