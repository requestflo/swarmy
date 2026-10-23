import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import { OnDemandRow } from './on-demand-row';

/** The status bits the HTTPS section counts (from `ingress.listDomains`). */
interface CertDomain {
  host: string;
  auto?: boolean;
  status?: { certificate: { expiresAt: string | null; error?: string | null } | null } | null;
  companionStatus?: { certificate: { expiresAt: string | null; error?: string | null } | null } | null;
}

/** An sslip.io name that embeds a private IP gets Caddy's local CA, not Let's Encrypt. */
const LAN_IP = /(^|\.)(10|127)-\d+-\d+-\d+\.|(^|\.)192-168-|(^|\.)172-(1[6-9]|2\d|3[01])-/;

const live = (s: CertDomain['status']): boolean => !!s?.certificate?.expiresAt && !s.certificate.error;

/** Certificates the edges serve right now, measured by a TLS handshake per host (never assumed). */
export function liveCertificates(domains: CertDomain[]): number {
  return domains.reduce((n, d) => n + (live(d.status) ? 1 : 0) + (live(d.companionStatus) ? 1 : 0), 0);
}

function Line({ label, children, right }: { label: string; children: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b py-2 last:border-b-0">
      <dt className="text-muted-foreground w-full shrink-0 text-[12.5px] sm:w-32">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13.5px]">{children}</dd>
      {right ? <dd className="text-muted-foreground font-mono text-[11.5px]">{right}</dd> : null}
    </div>
  );
}

/** Board 31's HTTPS card: who issues, how many are live, the no-domain address, on-demand. */
export function HttpsSection({
  serving,
  shared,
  bucket,
  domains,
  onDemand,
  admin,
  pending,
  onSetOnDemand,
}: {
  serving: boolean;
  shared: boolean;
  bucket: string | null;
  domains: CertDomain[];
  onDemand: { on: boolean; ask: string | null } | null;
  admin: boolean | undefined;
  pending: boolean;
  onSetOnDemand: (v: { enabled: boolean; askUrl?: string }) => void;
}): React.JSX.Element {
  const count = liveCertificates(domains);
  const auto = domains.find((d) => d.auto)?.host;
  return (
    <Section title="HTTPS" hint={serving ? 'already on' : undefined}>
      <dl className="flex flex-col">
        <Line label="Certificates" right={count > 0 ? `${count} live` : undefined}>
          {shared ? 'Let’s Encrypt, one account shared by every edge' : 'Let’s Encrypt, kept on the edge’s own server'}
          <Tech className="block">{shared ? `storage swarmy · replica s3 bucket ${bucket ?? 'swarmy-edge-certs'} · live = a TLS handshake per host` : 'Caddy data volume · live = a TLS handshake per host'}</Tech>
        </Line>
        {auto ? (
          <Line label="No domain yet?">
            Apps get <span className="font-mono text-[12.5px] break-all">{auto}</span>{' '}
            {LAN_IP.test(auto) ? 'with HTTPS from the edge’s own authority (a private address)' : 'with real HTTPS'}
          </Line>
        ) : null}
      </dl>
      {onDemand ? <OnDemandRow key={String(onDemand.on)} on={onDemand.on} ask={onDemand.ask} admin={admin} pending={pending} onSet={onSetOnDemand} /> : null}
    </Section>
  );
}
