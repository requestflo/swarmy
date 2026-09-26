import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { DomainPlan } from '@/components/ingress/domain-state';
import { RecordTable } from './record-table';
import { DnsPathPicture } from './dns-path-picture';
import { planRows, planTitle } from './plan-records';
import { REGISTRARS, registrarSteps } from './registrars';
import { normalizeHost } from './host-shape';
import type { AddForm } from './use-add-domain';

interface Props {
  form: AddForm;
  set: <K extends keyof AddForm>(k: K, v: AddForm[K]) => void;
  plan: DomainPlan | null;
  checking: boolean;
  service: string | null;
}

/** Step 2: the exact records, one plain paragraph, the registrar's steps, and the picture. */
export function AddDomainRecords({ form, set, plan, checking, service }: Props): React.JSX.Element {
  const host = normalizeHost(form.host);
  const mode = form.dns === 'nameserver' && plan?.nameserver ? 'nameserver' : 'registrar';
  const reg = REGISTRARS.find((r) => r.id === form.registrar) ?? REGISTRARS[REGISTRARS.length - 1]!;
  const rows = plan ? planRows(plan, mode, form.www) : [];
  const title = plan ? planTitle(rows, mode, plan.nameserver?.zone ?? null, reg.where) : 'The records appear here';
  const guidance = mode === 'nameserver' ? plan?.nameserver?.guidance : plan?.registrar;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="calm-eyebrow">Step 2 of 2 · create exactly this</span>
          <h2 className="say text-[1.35rem]">{title}</h2>
        </div>
        {rows.length ? <span className="text-muted-foreground text-[12.5px]">{rows.length} {rows.length === 1 ? 'row' : 'rows'}</span> : null}
      </div>
      {plan ? (
        <RecordTable rows={rows} className={cn(checking && 'opacity-70')} />
      ) : (
        <p className="calm-card text-muted-foreground px-4 py-6 text-[13.5px]">
          Type your domain on the left and swarmy works out the records from your servers’ public addresses.
        </p>
      )}
      {guidance ? (
        <p className="text-muted-foreground text-[13.5px] leading-relaxed">
          {guidance.summary} swarmy checks every 30 seconds for the first 10 minutes, then less often.
        </p>
      ) : null}
      <Tech>TTL: your registrar’s default is fine; 300 s or lower makes a change land sooner</Tech>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="calm-eyebrow">Where you bought it</span>
          <div role="tablist" aria-label="Where you bought it" className="flex flex-wrap gap-0.5">
            {REGISTRARS.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={form.registrar === r.id}
                onClick={() => set('registrar', r.id)}
                className={cn(
                  'min-h-8 rounded-[8px] px-2.5 text-[13px] font-medium pointer-coarse:min-h-11',
                  form.registrar === r.id ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <ol role="tabpanel" className="calm-card flex flex-col gap-2 px-4 py-3.5 text-[13.5px]">
          {registrarSteps(reg.id, plan?.apex ?? (host || 'your domain'), mode).map((s, i) => (
            <li key={s} className="flex gap-3">
              <span className="text-muted-foreground w-4 shrink-0 font-mono text-[12px] leading-[1.6]">{i + 1}</span>
              <span className="leading-snug">{s}</span>
            </li>
          ))}
        </ol>
      </div>
      <DnsPathPicture
        host={host}
        dnsLabel={mode === 'nameserver' ? 'swarmy’s nameservers' : `${reg.id === 'other' ? 'Your registrar’s' : reg.where} DNS`}
        dnsSub={mode === 'nameserver' ? 'nearest healthy edge' : `${rows.filter((r) => r.type === 'A' || r.type === 'AAAA').length || 'no'} addresses`}
        plan={plan}
        service={service}
      />
    </div>
  );
}
