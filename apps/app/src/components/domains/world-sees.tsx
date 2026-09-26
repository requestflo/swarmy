import * as React from 'react';
import { Section, StatusWord, Tech } from '@/components/calm';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { agreeCount, resolverAnswer, resolverName } from './lifecycle';

/**
 * "What the world sees": exactly the resolvers swarmy asked on the last
 * check (`dns.resolvers`), what each answered and whether it sees an edge.
 *
 * PENDING OWNER DECISION — a wider resolver fan-out (the board's 12-resolver
 * world map). The controller asks only its own resolver, swarmy's
 * nameservers (for hosts in a swarmy zone) and the DoH resolvers in
 * SWARMY_DOH_RESOLVERS (default 1.1.1.1 + 8.8.8.8). If more vantage points
 * are added, render them here from the same `dns.resolvers` list; don't
 * draw resolvers swarmy didn't ask.
 */
export function WorldSees({ d }: { d: DomainDetail }): React.JSX.Element {
  const resolvers = d.dns?.resolvers ?? [];
  const { seen, answered } = agreeCount(resolvers);
  const expected = [...new Set([...(d.guidance.records ?? []).filter((r) => r.type === 'A' || r.type === 'AAAA').map((r) => r.value)])];
  return (
    <Section
      title="What the world sees"
      count={answered ? `${seen} of ${answered} see your edges` : undefined}
      flush
    >
      {resolvers.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13.5px]">
          {d.lastCheckedAt ? 'The last check didn’t keep per-resolver answers. Check again to see them.' : 'Not checked yet. The first check runs within a minute.'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {resolvers.map((r) => {
            const n = resolverName(r.resolver);
            return (
              <li key={r.resolver} className="border-border flex min-h-12 flex-wrap items-center gap-x-3 gap-y-0.5 border-b py-2 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col sm:flex-none sm:basis-60">
                  <span className="text-[13.5px] font-semibold">{n.name}</span>
                  <span className="text-muted-foreground font-mono text-[11px]">{n.how}</span>
                </span>
                <span className="min-w-0 flex-1 font-mono text-[12.5px] break-all">{resolverAnswer(r)}</span>
                <StatusWord tone={r.error ? 'idle' : r.matches ? 'ok' : 'warn'} word={r.error ? 'no answer' : r.matches ? 'sees your edges' : 'elsewhere'} />
                <Tech className="basis-full">
                  {r.resolver} · A [{r.a.join(', ')}] · AAAA [{r.aaaa.join(', ')}] · CNAME [{r.cname.join(', ')}]
                  {r.nxdomain ? ' · NXDOMAIN' : ''}
                  {r.error ? ` · ${r.error}` : ''}
                </Tech>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted-foreground pt-2 pb-2 text-[12.5px] leading-relaxed">
        swarmy decides using these. Every one that answers has to see your edges; one that can’t be reached is skipped. When
        swarmy’s own resolver already sees another address, it doesn’t ask the public ones.
      </p>
      {expected.length ? <Tech className="pb-2">expected · {expected.join(' · ')}</Tech> : null}
    </Section>
  );
}
