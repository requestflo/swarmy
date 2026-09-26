import * as React from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmTopBar, Depth, Say, SayHeader, Section, StatusWord } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import type { DomainDetail, WwwMode } from '@/components/ingress/domain-state';
import { planRows } from './plan-records';
import { STATE_CHIP, checkClock } from './lifecycle';
import { useDomainVerify, useNow } from './use-domain-verify';
import { VerifyRail } from './verify-rail';
import { WorldSees } from './world-sees';
import { VerifyHostsCard } from './verify-hosts-card';
import { DiagnosisCard } from './diagnosis-card';
import { CertChecklist } from './cert-checklist';
import { VerifyFooter } from './verify-footer';
import { VerifyCode } from './verify-code';
import { RecordTable } from './record-table';

function headline(d: DomainDetail): React.ReactNode {
  switch (d.state) {
    case 'waiting_dns':
      return <>{d.host} is <Say tone="warn">waiting for DNS.</Say> <em>swarmy keeps checking by itself.</em></>;
    case 'verified':
    case 'issuing':
      return <>{d.host} points at your servers. <em>Getting its certificate now.</em></>;
    case 'active':
      return <>{d.host} is live on HTTPS. <em>The certificate renews itself.</em></>;
    case 'error':
      return <>{d.host} <Say tone="bad">needs a look.</Say></>;
  }
}

/** One domain's verification view (board 29): the rail, what resolvers see, the diagnosis and the certificate. */
export function DomainVerifyPage({ host }: { host: string }): React.JSX.Element {
  const v = useDomainVerify(host);
  const now = useNow();
  const d = v.detail;
  const crumbs = [{ label: 'Network', to: '/network' }, { label: 'domains', to: '/network' }, { label: host }];
  if (!d) {
    return (
      <div className="flex min-h-full flex-col">
        <CalmTopBar crumbs={crumbs} />
        {v.error ? <p className="text-muted-foreground px-6 pt-7 text-[13.5px] xl:px-8">Setting up {host}… (the front door is picking up the new address)</p> : null}
        <PageSkeleton variant="kpis" />
      </div>
    );
  }
  const chip = STATE_CHIP[d.state];
  const waiting = d.state === 'waiting_dns' || (d.state === 'error' && d.verifiedAt === null);
  const www = (v.route?.host === d.host ? (v.route?.www as WwwMode | null | undefined) : null) ?? 'none';
  const records = planRows({ host: d.host, apex: v.plan?.apex ?? d.host, isApex: false, registrar: d.guidance, nameserver: null, edges: v.plan?.edges ?? [] }, 'registrar', www);
  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar
        crumbs={crumbs}
        actions={
          <>
            <StatusWord tone={chip.tone} word={chip.word} />
            <span className="text-muted-foreground hidden font-mono text-[11.5px] sm:inline" aria-live="off">{checkClock(d, now)}</span>
            <Button onClick={v.check} disabled={v.checking} className="pointer-coarse:min-h-11">
              <RefreshCwIcon className="size-4" /> {v.checking ? 'Checking…' : 'Check again'}
            </Button>
          </>
        }
      />
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 pt-6 pb-24 sm:px-6 lg:pb-16 xl:px-8">
        <SayHeader size="md" title={headline(d)} lede={<span className="font-mono text-[12px] sm:hidden">{checkClock(d, now)}</span>} />
        <VerifyRail d={d} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-w-0 flex-col gap-5">
            <WorldSees d={d} edges={v.mapEdges} />
            {waiting && records.length ? (
              <Section title="The records to have" count={records.length}>
                <p className="text-muted-foreground text-[13px]">{d.guidance.summary}</p>
                <RecordTable rows={records} />
              </Section>
            ) : null}
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            <Depth at="code">
              <VerifyCode d={d} routeId={v.route?.id ?? null} />
            </Depth>
            <VerifyHostsCard d={d} v={v} />
            <DiagnosisCard d={d} />
            <CertChecklist d={d} tls={v.route?.tls ?? null} edgeName={v.edgeName} edgeCount={v.plan?.edges.length ?? 0} />
            <VerifyFooter d={d} v={v} />
          </aside>
        </div>
      </div>
    </div>
  );
}
