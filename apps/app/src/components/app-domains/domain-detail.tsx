import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { Depth, Section, StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { ProtectionEditor } from '@/components/ingress/protection-editor';
import { RemoveDomainConfirm, type StackDomain } from '@/components/ingress/stack-domain-row';
import { domainWords } from './domain-words';
import { CertCard } from './cert-card';
import { DomainFlow } from './domain-flow';
import { ProtectionsSection } from './protections-section';
import { RouteDriverPicker } from './route-driver-picker';
import { rulesOn } from './protection-rules';
import type { useDomainDetail } from './use-domain-detail';

/**
 * One address in full (board 30): how visits reach the service, the
 * certificate, and the protections as switches. Controls adds which front
 * door serves the address, every rule as the full form (cache, WAF-lite
 * methods and patterns, required headers) and removing the address.
 */
export function DomainDetailPanel({ stack, domain: d, info, protection }: {
  stack: string;
  domain: StackDomain;
  info: ReturnType<typeof useDomainDetail>;
  protection: { protection: StackDomain['protection']; save: (p: StackDomain['protection'], done?: string) => void; saving: boolean };
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const remove = useMutation(
    trpc.ingress.removeDomain.mutationOptions({
      onSuccess: () => {
        toast.success(`${d.host} removed`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const service = d.serviceName.replace(`${stack}_`, '');
  const target = `${service}:${d.targetPort}`;
  const w = domainWords({ ...d, protection: protection.protection });
  const p = protection.protection;
  const [formKey, setFormKey] = React.useState(0);
  return (
    <section aria-label={`${d.host} in detail`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <h2 className="font-mono text-[15px] font-semibold break-all">{d.host}{d.pathPrefix && d.pathPrefix !== '/' ? d.pathPrefix : ''}</h2>
        <span className="text-muted-foreground font-mono text-[12.5px]">→ {target}</span>
        <StatusWord tone={w.tone} word={w.word} />
        {d.companionHost ? <span className="text-muted-foreground font-mono text-[11.5px]">+ {d.companionHost}</span> : null}
      </div>
      <DomainFlow host={d.host} visitsPerMin={info.visitsPerMin} windowMinutes={info.windowMinutes} rulesOn={rulesOn(p)} target={target} />
      <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <CertCard host={d.host} tls={d.tls} detail={info.detail} nameOf={info.nameOf} stored={info.stored} storeTech={info.storeTech} />
        <ProtectionsSection host={d.host} service={service} protection={p} blocked={info.blocked} saving={protection.saving} save={protection.save} />
      </div>
      <Depth at="controls">
        <RouteDriverPicker domain={d} />
        <Section title="Every rule, as a form" hint="cache, WAF-lite methods and patterns, required headers">
          <div className="-mx-5 -mb-4 overflow-hidden rounded-b-[inherit]">
            <ProtectionEditor
              key={`${formKey}:${JSON.stringify(p)}`}
              initial={p}
              saving={protection.saving}
              onSave={(next) => protection.save(next)}
              onCancel={() => setFormKey((k) => k + 1)}
            />
          </div>
        </Section>
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <Tech>route on {d.serviceName}’s swarmy.ingress.routes label · host {d.host} · path {d.pathPrefix ?? '/'} · tls {d.tls}</Tech>
          <RemoveDomainConfirm host={d.host} pending={remove.isPending} onConfirm={() => remove.mutate({ id: d.id })} />
        </div>
      </Depth>
    </section>
  );
}
