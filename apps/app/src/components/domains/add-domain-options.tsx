import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { canPairWww, type DomainPlan } from '@/components/ingress/domain-state';
import { Segmented } from './segmented';
import { WWW_CHOICES, companionOf, normalizeHost, wwwExample } from './host-shape';
import type { AddForm, TlsChoice } from './use-add-domain';

interface Props {
  form: AddForm;
  set: <K extends keyof AddForm>(k: K, v: AddForm[K]) => void;
  plan: DomainPlan | null;
}

const TLS_NOTE: Record<TlsChoice, string> = {
  auto: 'Let’s Encrypt, asked only once DNS points here. It renews itself.',
  custom: 'You bring the certificate and swarmy never asks Let’s Encrypt. There’s no upload screen yet, so pick this only if the front door already has it.',
  off: 'Plain HTTP. Browsers will mark the site “not secure”.',
};

/** Step 1, bottom half: HTTPS, the www companion, and how DNS reaches the edges. */
export function AddDomainOptions({ form, set, plan }: Props): React.JSX.Element {
  const host = normalizeHost(form.host);
  const other = companionOf(host);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">HTTPS</span>
        <Segmented<TlsChoice>
          label="HTTPS"
          mono
          value={form.tls}
          onChange={(v) => set('tls', v)}
          options={[{ value: 'auto', label: 'auto' }, { value: 'custom', label: 'my own cert' }, { value: 'off', label: 'off' }]}
        />
        <p className="text-muted-foreground text-[12.5px]">{TLS_NOTE[form.tls]}</p>
        <Tech>tls {form.tls === 'custom' ? 'manual' : form.tls}{form.tls === 'auto' ? ' · ACME HTTP-01 / TLS-ALPN-01 on :80 and :443 (wildcards use DNS-01)' : ''}</Tech>
      </div>
      {canPairWww(host) && other ? (
        <div className="calm-card flex flex-col gap-2.5 px-4 py-3.5">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
            <span className="font-mono font-semibold">{other}</span>
            <span className="text-muted-foreground text-[12px]">gets its own record, certificate and status</span>
          </p>
          <Segmented label={`What ${other} does`} mono value={form.www} onChange={(v) => set('www', v)} options={WWW_CHOICES} />
          <p className="text-muted-foreground font-mono text-[12px]">{wwwExample(host, form.www)}</p>
        </div>
      ) : null}
      <DnsModeChoice form={form} set={set} plan={plan} />
    </div>
  );
}

function DnsModeChoice({ form, set, plan }: Props): React.JSX.Element {
  const zone = plan?.nameserver?.zone ?? null;
  const edges = plan?.edges.length ?? 0;
  const apex = plan?.apex ?? normalizeHost(form.host);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium">How DNS reaches your edges</span>
      <div role="group" aria-label="How DNS reaches your edges" className="grid gap-2 sm:grid-cols-2">
        <Pick on={form.dns === 'registrar'} onClick={() => set('dns', 'registrar')} title="Records at my registrar" sub={`address records → ${edges === 1 ? 'your edge' : edges ? `all ${edges} edges` : 'your edges'}`} />
        <Pick
          on={form.dns === 'nameserver'}
          disabled={!zone}
          onClick={() => set('dns', 'nameserver')}
          title="Let swarmy be the nameserver"
          sub={zone ? `${zone} · nearest edge for each visitor` : 'not available for this domain'}
        />
      </div>
      {!zone && plan ? (
        <p className="text-muted-foreground text-[12.5px]">
          swarmy doesn’t serve {apex} as a zone yet. Add it under{' '}
          <Link to="/network" className="text-foreground underline underline-offset-2">Network → Nearest front door</Link> to use this.
        </p>
      ) : null}
    </div>
  );
}

function Pick({ on, disabled, onClick, title, sub }: { on: boolean; disabled?: boolean; onClick: () => void; title: string; sub: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'calm-card flex min-h-14 flex-col items-start gap-0.5 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-55',
        on && 'ring-foreground/40 ring-2',
      )}
    >
      <span className="text-[13.5px] font-semibold">{title}</span>
      <span className="text-muted-foreground text-[12px]">{sub}</span>
    </button>
  );
}
