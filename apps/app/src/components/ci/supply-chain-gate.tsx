import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Section, Tech } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
import { SCAN_LIMIT, WINDOW_DAYS, gateReceipts, shortRef, type DecisionLike } from './gate-receipts';

const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;
const when = (d: DecisionLike): string => `${d.stack ?? 'a deploy'} · ${new Date(d.at).toLocaleDateString()}`;

/**
 * Supply-chain gate (board 51): the image checks a deploy passes, each with
 * its receipt from the last 30 days of real scans and admission decisions.
 * The switches stay in Image policy at Controls.
 */
export function SupplyChainGate(): React.JSX.Element {
  const trpc = useTRPC();
  const policy = useQuery(trpc.registryPolicy.getPolicy.queryOptions());
  const scans = useQuery({ ...trpc.registryPolicy.listScans.queryOptions({ limit: SCAN_LIMIT }), refetchInterval: 30_000 });
  const decisions = useQuery(trpc.guardrails.recentDecisions.queryOptions({ limit: 200 }));
  const p = policy.data;
  const r = scans.data && decisions.data ? gateReceipts(scans.data, decisions.data, Date.now()) : null;
  return (
    <Section title="Supply-chain gate" hint={`checked when a deploy is admitted, for images from your registry · last ${WINDOW_DAYS} days`}>
      {!p || !r ? (
        <RowsSkeleton rows={3} />
      ) : (
        <div className="flex flex-col">
          <Gate title="Scan every build" on desc="Each new image is checked for known security holes on the builder, after the push. It never slows the build." tech="Trivy · ImageScan rows">
            {r.scans === 0
              ? 'Nothing scanned in the last 30 days.'
              : `${r.scans}${r.scansCapped ? '+' : ''} scans · ${r.withCritical} with a critical CVE · ${r.withHigh} with high${r.errored ? ` · ${r.errored} couldn’t be scanned` : ''}`}
          </Gate>
          <Gate title="Block critical CVEs" on={p.blockCriticalCves} desc="A deploy with a critical vulnerability is refused. Unscanned images only warn." tech="images/critical-cves · block · images/unscanned · warn"
            items={[...r.criticalImages.slice(0, 3).map((i) => `${shortRef(i.ref)} · ${i.critical} critical`), ...r.overrides.cve.map((d) => `went past it by override: ${when(d)}`)]}>
            {`${p.blockCriticalCves ? 'Refuses' : 'Off: would refuse'} ${n(r.criticalImages.length, 'image')} scanned in the last 30 days`}
          </Gate>
          <Gate title="Require signed images" on={p.requireSignedImages} desc="Only images signed with your key deploy. If a signature can’t be checked, the deploy is refused." tech="images/unsigned · block · cosign verify · fails closed"
            items={r.overrides.unsigned.map((d) => `went ahead unsigned by override: ${when(d)}`)}>
            {!p.signingEnabled ? 'No signing key yet, so nothing is signed.' : !p.requireSignedImages ? 'Off: unsigned images deploy without a check.' : r.overrides.unsigned.length ? `${n(r.overrides.unsigned.length, 'deploy')} went past it by override` : 'No deploy went past it by override in the last 30 days.'}
          </Gate>
          <Tech>
            {p.signingEnabled ? 'cosign key set · private half vault-encrypted, never shown' : 'no cosign key yet: turn signing on in Image policy'} · refused deploys aren’t kept, overrides are (audit log)
          </Tech>
        </div>
      )}
    </Section>
  );
}

interface GateProps {
  title: string;
  on: boolean;
  desc: string;
  tech: string;
  items?: string[];
  children: React.ReactNode;
}

function Gate({ title, on, desc, tech, items = [], children }: GateProps): React.JSX.Element {
  return (
    <div className="border-border flex flex-col gap-1.5 border-b py-3 first:pt-0 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold">{title}</span>
          <span className="text-muted-foreground text-[12.5px]">{desc}</span>
        </span>
        <span className={cn('shrink-0 text-xs font-semibold', on ? 'text-tone-ok' : 'text-tone-idle')}>{on ? 'On' : 'Off'}</span>
      </div>
      <div className={cn('flex flex-col gap-0.5 rounded-lg border px-3 py-2', on ? 'border-tone-ok/30' : 'border-border')}>
        <span className="text-[12.5px] font-semibold">{children}</span>
        {items.map((t) => (
          <span key={t} className="text-muted-foreground font-mono text-[11px]">
            {t}
          </span>
        ))}
      </div>
      <Tech>{tech}</Tech>
    </div>
  );
}
