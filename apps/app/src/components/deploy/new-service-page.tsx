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
import { NewServiceAside } from './new-service-aside';

type FormValues = z.input<typeof CreateServiceInput>;
const FORM_ID = 'new-service-form';

/**
 * Deploy → One image (canvas "Configure" for an image): name, image, which
 * app it joins and its web address at Summary; env and ports at Controls;
 * POST /services at Code. The service fields are the shared services/* ones.
 */
export function NewServicePage({ stack }: { stack?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
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
      onError: (e) => toast.error(e.message),
    }),
  );
  const submit = form.handleSubmit(
    (values) => {
      const v = values as typeof CreateServiceInput._output;
      create.mutate({ ...v, project: v.project?.trim() || undefined });
    },
    () => toast.error('Check the highlighted fields before deploying.'),
  );
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
            <ServiceCoreFields form={form} />
            <ServiceIngressFields form={form} />
            <Depth at="controls">
              <ServiceEnvFields form={form} />
              <ServicePortFields form={form} />
            </Depth>
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            <NewServiceAside form={form} pending={create.isPending} onCancel={cancel} />
          </aside>
        </form>
      </Form>
    </div>
  );
}
