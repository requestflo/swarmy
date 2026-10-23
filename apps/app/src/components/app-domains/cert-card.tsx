import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink, StatusWord, Tech } from '@/components/calm';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { relTime } from '@/lib/format';
import { dayLabel, daysLeft, renewsIn } from './cert-model';

interface Props {
  host: string;
  tls: string;
  detail: DomainDetail | null;
  /** Server name for an edge's public IP. */
  nameOf: (ip: string) => string;
  /** Where certificates are kept (`certStorage`), null while unknown. */
  stored: string | null;
  storeTech: string | null;
}

/**
 * The address's certificate (board 30), from what the front door can see:
 * the TLS probe of each edge (`ingress.domainStatus`) and where the
 * certificate store lives (`ingress.getConfig` certStorage).
 */
export function CertCard({ host, tls, detail: d, nameOf, stored, storeTech }: Props): React.JSX.Element {
  const more = <Link to="/network/domains/$host" params={{ host }}><SectionLink>DNS checks →</SectionLink></Link>;
  if (tls === 'off') {
    return (
      <Section title="Certificate" action={more}>
        <p className="text-muted-foreground text-[13.5px]">HTTPS is off for this address, so there is no certificate.</p>
      </Section>
    );
  }
  const c = d?.certificate ?? null;
  const left = daysLeft(c?.expiresAt);
  const renews = renewsIn(c?.expiresAt);
  const edges = c?.edges ?? [];
  const word = !d ? null : c?.expiresAt ? { tone: 'ok' as const, word: 'secured' } : d.state === 'error' ? { tone: 'bad' as const, word: 'needs you' } : { tone: 'info' as const, word: 'getting it' };
  return (
    <Section title="Certificate" action={<>{word ? <StatusWord tone={word.tone} word={word.word} /> : null}{more}</>}>
      {!d ? (
        <div className="shimmer-line h-24 rounded-md" aria-hidden />
      ) : !c?.expiresAt ? (
        <p className="text-muted-foreground text-[13.5px]">{c?.error ?? d.reason}</p>
      ) : (
        <div className="flex items-center gap-4">
          <div className="border-status-online/60 flex size-20 shrink-0 flex-col items-center justify-center rounded-full border-[5px]">
            <span className="font-mono text-[18px] leading-none font-semibold">{left}</span>
            <span className="text-muted-foreground font-mono text-[9.5px]">days left</span>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[14px] font-semibold">{c.issuer ?? 'Trusted issuer'}</span>
            <span className="text-muted-foreground font-mono text-[11.5px]">expires {dayLabel(c.expiresAt)}</span>
            {renews !== null ? <span className="text-tone-ok text-[12.5px] font-semibold">renews itself in {renews} day{renews === 1 ? '' : 's'}</span> : null}
          </div>
        </div>
      )}
      <dl className="flex flex-col text-[13px]">
        <Fact k="Served by">
          {edges.length ? edges.map((e, i) => (
            <span key={e.ip} className={e.ok ? '' : 'text-tone-warn'}>{i ? ' · ' : ''}{nameOf(e.ip)}{e.ok ? '' : ' (not yet)'}</span>
          )) : <span className="text-muted-foreground">not probed yet</span>}
        </Fact>
        {stored ? <Fact k="Stored in">{stored}</Fact> : null}
      </dl>
      {c ? <Tech>issuer {c.issuer ?? '—'} · notAfter {c.expiresAt ?? '—'} · probed {relTime(c.checkedAt)} with a TLS handshake to each edge{edges.filter((e) => e.error).map((e) => ` · ${e.ip}: ${e.error}`).join('')}</Tech> : null}
      {storeTech ? <Tech>{storeTech}</Tech> : null}
    </Section>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex min-h-9 items-center gap-3 border-b py-1.5 last:border-b-0">
      <dt className="text-muted-foreground w-24 shrink-0 text-[12.5px] font-semibold">{k}</dt>
      <dd className="min-w-0 font-mono text-[12px] break-words">{children}</dd>
    </div>
  );
}
