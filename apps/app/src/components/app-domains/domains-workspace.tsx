import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CalmRow, RowList, Section } from '@/components/calm';
import type { StackDomain } from '@/components/ingress/stack-domain-row';
import { DomainsCode } from './domains-code';
import { domainWords } from './domain-words';
import { DomainDetailPanel } from './domain-detail';
import { useDomainDetail } from './use-domain-detail';
import { useRouteProtection } from './use-route-protection';

/**
 * The app's addresses and the picked one in full (board 30). The pick lives
 * in the URL (`?domain=`), else the first address of your own (not the
 * automatic one).
 */
export function DomainsWorkspace({ stack, rows, selected }: { stack: string; rows: StackDomain[]; selected?: string }): React.JSX.Element {
  const navigate = useNavigate();
  const d = rows.find((r) => r.host === selected) ?? rows.find((r) => !r.auto) ?? rows[0]!;
  const info = useDomainDetail(d.host, d.ingressDriver);
  const protection = useRouteProtection(d);
  return (
    <>
      <DomainsCode stack={stack} rows={rows} caddy={info.caddy ? { host: d.host, block: info.caddy } : null} />
      <Section title="Addresses" count={rows.length} hint={rows.length > 1 ? 'pick one to see its certificate and protections' : undefined} flush>
        <RowList label="Addresses">
          {rows.map((r) => {
            const w = domainWords(r);
            const on = r.id === d.id;
            return (
              <CalmRow
                key={r.id}
                tone={w.tone}
                name={`${r.host}${r.pathPrefix && r.pathPrefix !== '/' ? r.pathPrefix : ''}`}
                sub={`→ ${r.serviceName.replace(`${stack}_`, '')}:${r.targetPort}${r.auto ? ' · automatic address' : ''}`}
                say={w.say}
                word={w.word}
                wordTone={w.tone}
                onClick={() => void navigate({ to: '/stacks/$name/network', params: { name: stack }, search: { domain: r.host }, replace: true })}
                className={on ? 'bg-foreground/[0.04]' : undefined}
                trailing={on ? <span className="text-primary hidden font-mono text-[11px] sm:inline">showing ↓</span> : null}
              />
            );
          })}
        </RowList>
      </Section>
      <DomainDetailPanel key={d.id} stack={stack} domain={d} info={info} protection={protection} />
    </>
  );
}
