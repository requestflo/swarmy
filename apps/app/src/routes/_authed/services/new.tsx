import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Loader2Icon, RocketIcon } from 'lucide-react';
import { CreateServiceInput } from '@swarmy/core';
import { Button, Form, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { ServiceCoreFields } from '@/components/services/service-core-fields';
import { ServiceEnvFields } from '@/components/services/service-env-fields';
import { ServicePortFields } from '@/components/services/service-port-fields';
import { ServiceIngressFields } from '@/components/services/service-ingress-fields';

export const Route = createFileRoute('/_authed/services/new')({
  component: NewServicePage,
});

type FormValues = z.input<typeof CreateServiceInput>;

function NewServicePage(): React.JSX.Element {
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
      ingress: { enabled: false, tls: 'auto' },
    },
  });

  const create = useMutation(
    trpc.services.create.mutationOptions({
      onSuccess: (res) => {
        toast.success('Service deploying');
        void navigate({ to: '/services/$serviceId', params: { serviceId: res.id } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = form.handleSubmit((values) => {
    create.mutate(values as typeof CreateServiceInput._output);
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Deploy"
        title={<>Ship a <em>service</em>.</>}
        description="Point us at a container image. We'll roll it out across the swarm."
      />
      <Form {...form}>
        <form onSubmit={submit} className="grid gap-5">
          <ServiceCoreFields form={form} />
          <ServiceEnvFields form={form} />
          <ServicePortFields form={form} />
          <ServiceIngressFields form={form} />

          <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="rounded-full font-bold"
              onClick={() => navigate({ to: '/services' })}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending}
              className="rounded-full font-bold shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]"
            >
              {create.isPending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <RocketIcon className="size-4" />
              )}
              Deploy
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
