import * as React from 'react';
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { PrivateHostNote } from '@/components/ingress/private-host-note';
import type { DomainPlan } from '@/components/ingress/domain-state';
import { hostKind, normalizeHost } from './host-shape';
import type { Target } from './use-add-targets';
import type { AddForm } from './use-add-domain';

interface Props {
  form: AddForm;
  set: <K extends keyof AddForm>(k: K, v: AddForm[K]) => void;
  targets: Target[];
  plan: DomainPlan | null;
  autoAddress: string | null;
}

const KIND_WORD = { apex: 'apex', subdomain: 'subdomain', wildcard: 'wildcard' } as const;

function kindNote(kind: ReturnType<typeof hostKind>, plan: DomainPlan | null): string | null {
  if (kind === 'apex') return 'An apex can’t use a CNAME, so we give you A records for every edge.';
  if (kind === 'wildcard') return 'A wildcard gets its certificate over DNS, so its zone needs to be one swarmy serves (or a DNS provider token under Front door).';
  if (kind === 'subdomain') {
    const alt = plan?.registrar.alternatives.find((r) => r.type === 'CNAME');
    return alt ? `A subdomain can also use one CNAME to ${alt.value}, which follows your edges if their addresses change.` : 'A subdomain gets the same A records, one per edge.';
  }
  return null;
}

/** Step 1, top half: the domain (apex/subdomain detected live) and where visitors go. */
export function AddDomainWhat({ form, set, targets, plan, autoAddress }: Props): React.JSX.Element {
  const kind = hostKind(form.host);
  const host = normalizeHost(form.host);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="add-domain-host" className="text-[13px]">Domain</Label>
        <Input
          id="add-domain-host"
          value={form.host}
          onChange={(e) => set('host', e.target.value)}
          placeholder="shop.example.com"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        {kind ? (
          <p className="flex flex-wrap items-center gap-2 text-[12.5px]" aria-live="polite">
            <span className="bg-surface-2 dark:bg-accent inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[12px]">
              {host} <span className="text-muted-foreground">{KIND_WORD[kind]}</span>
            </span>
            <span className="text-muted-foreground">{kindNote(kind, plan)}</span>
          </p>
        ) : form.host.trim() ? (
          <p className="text-muted-foreground text-[12.5px]">Type a full name, like shop.example.com.</p>
        ) : null}
        <PrivateHostNote host={host} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_96px_110px]">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="add-domain-target" className="text-[13px]">Send visitors to</Label>
          <Select value={form.serviceId} onValueChange={(v) => set('serviceId', v)}>
            <SelectTrigger id="add-domain-target" className="pointer-coarse:min-h-11 w-full">
              <SelectValue placeholder={targets.length ? 'Pick an app' : 'No apps yet'} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t.serviceId} value={t.serviceId}>
                  {t.stack} / {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="add-domain-port" className="text-[13px]">Port</Label>
          <Input id="add-domain-port" type="number" inputMode="numeric" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} className="font-mono" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="add-domain-path" className="text-[13px]">Path</Label>
          <Input id="add-domain-path" value={form.path} onChange={(e) => set('path', e.target.value)} placeholder="/" className="font-mono" />
        </div>
      </div>
      {autoAddress ? (
        <p className={cn('text-muted-foreground flex items-start gap-2 font-mono text-[11.5px] leading-relaxed')}>
          <span aria-hidden className="bg-status-idle mt-1.5 size-1.5 shrink-0 rounded-full" />
          <span className="break-all">{autoAddress} · automatic · keeps working alongside your domain</span>
        </p>
      ) : null}
      <Tech>adds a route to the service’s swarmy.ingress.routes label; no redeploy</Tech>
    </div>
  );
}
