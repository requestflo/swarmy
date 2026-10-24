import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { CreateServiceInput } from '@swarmy/core';
import { Form, toast } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { ServiceCoreFields } from '@/components/services/service-core-fields';
import { ServiceEnvFields } from '@/components/services/service-env-fields';
import { ServicePortFields } from '@/components/services/service-port-fields';
import { ServiceIngressFields } from '@/components/services/service-ingress-fields';
import { DeployOverridePanel } from '@/components/services/deploy-override-panel';
import { policyRefusal, type PolicyRefusal } from '@/components/services/policy-refusal';
import { useIsAdmin } from '@/components/ingress/use-is-admin';
import { NewServiceAside } from './new-service-aside';

type FormValues = z.input<typeof CreateServiceInput>;
type Override = { override: true; overrideReason?: string };
const FORM_ID = 'new-service-form';

/**
 * Deploy → One image (canvas "Configure" for an image): name, image, which
 * app it joins and its web address at Summary; env and ports at Controls;
 * POST /services at Code. The service fields are the shared services/* ones.
 * A deploy a guardrail refuses shows its findings and, for an admin, an
 * audited "Deploy anyway" that needs a reason.
 */
export function NewServicePage({ stack }: { stack?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  // Kept across the retry, so the panel (and its reason) stays up while it runs.
  const [refusal, setRefusal] = React.useState<PolicyRefusal | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(CreateServiceInput),
    defaultValues: {
      name: '',
      image: '',
      replicas: 1,
      command: [],
      env: [],
      ports: [],
      volumes: [],
      networks: [],
      constraints: [],
      project: stack ?? '',
      ingress: { enabled: false, tls: 'auto' },
    },
  });
  const create = useMutation(
    trpc.services.create.mutationOptions({
      onSuccess: (res) => {
        toast.success(`${form.getValues('name')} is deploying`);
        void navigate({ to: '/services/$serviceId', params: { serviceId: res.id } });
      },
      onError: (e) => {
        const r = policyRefusal(e);
        setRefusal(r);
        if (!r) toast.error(e.message);
      },
    }),
  );
  const deployWith = (extra?: Override) =>
    form.handleSubmit(
      (values) => {
        const v = values as typeof CreateServiceInput._output;
        create.mutate({ ...v, project: v.project?.trim() || undefined, ...extra });
      },
      () => toast.error('Check the highlighted fields before deploying.'),
    );
  const submit = deployWith();
  const deployAnyway = (reason: string): void =>
    void deployWith({ override: true, ...(reason ? { overrideReason: reason } : {}) })();
  const cancel = (): void =>
    void (stack ? navigate({ to: '/stacks/$name', params: { name: stack } }) : navigate({ to: '/deploy' }));

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        eyebrow="Nothing runs until you press Deploy"
        title={stack ? `Add an image to ${stack}.` : 'Run one image.'}
        description="Point swarmy at a container image from any registry. It runs it, and gives it a web address if you want one."
      />
      <Form {...form}>
        <form id={FORM_ID} onSubmit={submit} className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col gap-5">
            {refusal ? (
              <DeployOverridePanel refusal={refusal} isAdmin={isAdmin} pending={create.isPending} onDeployAnyway={deployAnyway} />
            ) : null}
            <ServiceCoreFields form={form} />
            <ServiceIngressFields form={form} />
            <Depth at="controls">
              <ServiceEnvFields form={form} />
              <ServicePortFields form={form} />
            </Depth>
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            <NewServiceAside form={form} pending={create.isPending} refusal={refusal} onCancel={cancel} />
          </aside>
        </form>
      </Form>
    </div>
  );
}
