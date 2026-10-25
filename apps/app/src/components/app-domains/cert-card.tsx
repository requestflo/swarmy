import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Depth, Section, SectionLink, StatusWord, Tech, TONE_TEXT } from '@/components/calm';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { relTime } from '@/lib/format';
import { dayLabel, daysLeft } from './cert-model';
import { factsTech, issuedLine, type CertFacts } from './cert-facts-model';
import { CertFactRows } from './cert-fact-rows';
import { RenewalsRow } from './cert-renewals-row';
import { renewalTech, renewsLine } from './cert-renewal-words';
import { RenewNow } from './renew-now';

interface Props {
  host: string;
  tls: string;
  detail: DomainDetail | null;
  /** What the edges hold, from their own storage (`ingress.certFacts`); null while unknown. */
  facts: CertFacts | null;
  /** Server name for an edge's public IP. */
  nameOf: (ip: string) => string;
  /** Where certificates are kept (`certStorage`), null while unknown. */
  stored: string | null;
  storeTech: string | null;
}

/**
 * The address's certificate (board 30): what each edge holds in its own
 * Caddy storage (`ingress.certFacts`: issuer, issued, covers, which servers),
 * the TLS probe of each edge (`ingress.domainStatus`) where they can't say,
 * where the certificate store lives (`ingress.getConfig` certStorage), and
 * Renew now at Controls.
 */
export function CertCard({ host, tls, detail: d, facts, nameOf, stored, storeTech }: Props): React.JSX.Element {
  const more = <Link to="/network/domains/$host" params={{ host }}><SectionLink>DNS checks →</SectionLink></Link>;
  if (tls === 'off') {
    return (
      <Section title="Certificate" action={more}>
        <p className="text-muted-foreground text-[13.5px]">HTTPS is off for this address, so there is no certificate.</p>
      </Section>
    );
  }
  const c = d?.certificate ?? null;
  const held = facts?.cert ?? null;
  const expiresAt = held?.notAfter ?? c?.expiresAt ?? null;
  const left = daysLeft(expiresAt);
  const renews = renewsLine(facts, expiresAt);
  const word = !d ? null : expiresAt ? { tone: 'ok' as const, word: 'secured' } : d.state === 'error' ? { tone: 'bad' as const, word: 'needs you' } : { tone: 'info' as const, word: 'getting it' };
  const tech = factsTech(facts);
  const renewRule = renewalTech(facts);
  return (
    <Section title="Certificate" action={<>{word ? <StatusWord tone={word.tone} word={word.word} /> : null}{more}</>}>
      {!d ? (
        <div className="shimmer-line h-24 rounded-md" aria-hidden />
      ) : !expiresAt ? (
        <p className="text-muted-foreground text-[13.5px]">{c?.error ?? d.reason}</p>
      ) : (
        <div className="flex items-center gap-4">
          <div className="border-status-online/60 flex size-20 shrink-0 flex-col items-center justify-center rounded-full border-[5px]">
            <span className="font-mono text-[18px] leading-none font-semibold">{left}</span>
            <span className="text-muted-foreground font-mono text-[9.5px]">days left</span>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[14px] font-semibold">{held?.issuer ?? c?.issuer ?? 'Trusted issuer'}</span>
            <span className="text-muted-foreground font-mono text-[11.5px]">{held ? issuedLine(held.notBefore, held.notAfter) : `expires ${dayLabel(expiresAt)}`}</span>
            {renews ? <span className={`${TONE_TEXT[renews.tone]} text-[12.5px] font-semibold`}>{renews.text}</span> : null}
          </div>
        </div>
      )}
      <CertFactRows host={host} facts={facts} probed={c?.edges ?? []} nameOf={nameOf} stored={stored}>
        <RenewalsRow facts={facts} />
      </CertFactRows>
      <Depth at="controls">
        <RenewNow host={host} facts={facts} />
      </Depth>
      {c ? <Tech>TLS probe · issuer {c.issuer ?? '—'} · notAfter {c.expiresAt ?? '—'} · probed {relTime(c.checkedAt)} with a handshake to each edge{c.edges.filter((e) => e.error).map((e) => ` · ${e.ip}: ${e.error}`).join('')}</Tech> : null}
      {renewRule ? <Tech>{renewRule}</Tech> : null}
      {tech ? <Tech>{tech}</Tech> : null}
      {storeTech ? <Tech>{storeTech}</Tech> : null}
    </Section>
  );
}
