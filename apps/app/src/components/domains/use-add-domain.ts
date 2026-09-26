import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { WwwMode } from '@/components/ingress/domain-state';
import { canPairWww } from '@/components/ingress/domain-state';
import { isValidHost, normalizeHost } from './host-shape';
import type { DnsMode } from './plan-records';
import type { RegistrarId } from './registrars';

export type TlsChoice = 'auto' | 'custom' | 'off';

export interface AddForm {
  host: string;
  serviceId: string;
  port: number;
  path: string;
  tls: TlsChoice;
  www: WwwMode | 'none';
  dns: DnsMode;
  registrar: RegistrarId;
}

/** The two-pane form's state and its one action: add (if new), check now, open the verification view. */
export function useAddDomain(initial: { host?: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = React.useState<AddForm>({
    host: initial.host ?? '',
    serviceId: '',
    port: 80,
    path: '',
    tls: 'auto',
    www: 'none',
    dns: 'registrar',
    registrar: 'other',
  });
  const set = React.useCallback(<K extends keyof AddForm>(k: K, v: AddForm[K]) => setForm((f) => ({ ...f, [k]: v })), []);
  const add = useMutation(trpc.ingress.addDomain.mutationOptions());
  const verify = useMutation(trpc.ingress.verifyDomain.mutationOptions());
  const host = normalizeHost(form.host);
  const ready = isValidHost(host) && form.serviceId !== '' && form.port >= 1 && form.port <= 65535;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    try {
      const existing = await qc.fetchQuery(trpc.ingress.listDomains.queryOptions());
      if (!existing.some((d) => d.host === host)) {
        await add.mutateAsync({
          host,
          serviceId: form.serviceId,
          targetPort: form.port,
          tls: form.tls,
          pathPrefix: form.path.trim() && form.path.trim() !== '/' ? form.path.trim() : undefined,
          www: form.www === 'none' || !canPairWww(host) ? undefined : form.www,
        });
      }
      // The route label may still be landing; the worker checks it shortly either way.
      await verify.mutateAsync({ host }).catch(() => undefined);
      void qc.invalidateQueries();
      void navigate({ to: '/network/domains/$host', params: { host } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return { form, set, host, ready, submit, pending: add.isPending || verify.isPending };
}
