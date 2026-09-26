import * as React from 'react';
import { StatusWord, Tech } from '@/components/calm';
import { canPairWww, type DomainDetail, type DomainStatus, type WwwMode } from '@/components/ingress/domain-state';
import { Segmented } from './segmented';
import { WWW_CHOICES, companionOf } from './host-shape';
import { STATE_CHIP } from './lifecycle';
import type { DomainVerify } from './use-domain-verify';

/** The www choice for this host (setDomainWww) and each host's own state (apex + www). */
export function VerifyHostsCard({ d, v }: { d: DomainDetail; v: DomainVerify }): React.JSX.Element {
  const route = v.route;
  const primary = route?.host ?? d.host;
  const other = companionOf(primary);
  const www: WwwMode | 'none' = (route?.www as WwwMode | null | undefined) ?? 'none';
  const rows: DomainStatus[] = [d, ...(d.companion ? [d.companion] : [])];
  const target = route ? `${route.stack} / ${route.serviceName.replace(`${route.stack}_`, '')}:${route.targetPort}` : null;
  return (
    <section aria-label="Hosts" className="calm-card flex flex-col gap-3 px-4 py-4">
      {canPairWww(primary) && other && route ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px]">www</span>
          <Segmented
            label={`What ${other} does`}
            mono
            value={www}
            disabled={v.savingWww}
            onChange={(next) => v.saveWww(next === 'none' ? null : next)}
            options={WWW_CHOICES}
          />
        </div>
      ) : null}
      <ul className="flex flex-col">
        {rows.map((h) => {
          const chip = STATE_CHIP[h.state];
          const meta =
            h.host === primary
              ? `${d.guidance.records.map((r) => r.type).filter((t, i, a) => a.indexOf(t) === i).join(', ') || 'records'} → ${d.guidance.records.map((r) => v.edgeName(r.value)).join(', ') || 'your edges'}${target ? ` · ${target}` : ''}`
              : www === 'redirect-www-to-apex' || www === 'redirect-apex-to-www'
                ? `308 → ${primary} · own DNS record and certificate`
                : 'serves the site too · own certificate';
          return (
            <li key={h.host} className="border-border flex min-h-12 items-center gap-3 border-b py-2 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[13px] font-semibold">{h.host}</span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">{meta}</span>
              </span>
              <StatusWord tone={chip.tone} word={chip.word} />
            </li>
          );
        })}
      </ul>
      {route ? <Tech>route {route.id} · tls {route.tls}{route.pathPrefix ? ` · path ${route.pathPrefix}` : ''}</Tech> : null}
    </section>
  );
}
