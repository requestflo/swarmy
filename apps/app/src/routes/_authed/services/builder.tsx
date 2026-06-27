import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { DownloadIcon, FileInputIcon, Loader2Icon } from 'lucide-react';
import type { CreateServiceInput } from '@swarmy/core';
import type { ServiceModelOut } from '@swarmy/core/compose';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { ServiceBuilder } from '@/components/service-builder/service-builder';
import { ImportComposeDialog } from '@/components/service-builder/import-compose-dialog';
import { useServiceModel } from '@/components/service-builder/use-service-model';

export const Route = createFileRoute('/_authed/services/builder')({
  component: ServiceBuilderPage,
});

/** Map the canonical model down to the deploy input's common-field subset. */
function toCreateInput(m: ServiceModelOut): CreateServiceInput {
  return {
    name: m.name,
    image: m.image,
    replicas: m.mode === 'global' ? 1 : m.replicas,
    command: m.command,
    env: Object.entries(m.env).map(([key, value]) => ({ key, value })),
    ports: m.ports,
    volumes: m.mounts,
    networks: m.networks,
    constraints: m.placement?.constraints ?? [],
  };
}

function ServiceBuilderPage(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const state = useServiceModel();
  const [importOpen, setImportOpen] = React.useState(false);

  const create = useMutation(
    trpc.services.create.mutationOptions({
      onSuccess: (res) => {
        toast.success('Service deploying');
        void navigate({ to: '/services/$serviceId', params: { serviceId: res.id } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const exportCompose = useMutation(
    trpc.builder.exportCompose.mutationOptions({
      onSuccess: (res) => {
        const blob = new Blob([res.yaml], { type: 'text/yaml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.model.name || 'service'}.compose.yaml`;
        a.click();
        URL.revokeObjectURL(url);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Service builder"
        title={<>Build a <em>service</em>.</>}
        description="Visual editor over the full Swarm schema. Import a compose file, or export yours."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
              <FileInputIcon className="size-4" /> Import compose
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => exportCompose.mutate({ models: [state.model] })}
              disabled={!state.model.name || !state.model.image}
            >
              <DownloadIcon className="size-4" /> Export compose
            </Button>
          </div>
        }
      />

      <ServiceBuilder state={state} />

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => navigate({ to: '/services' })}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={create.isPending || !state.model.name || !state.model.image}
          onClick={() => create.mutate(toCreateInput(state.model))}
        >
          {create.isPending && <Loader2Icon className="animate-spin" />}
          Deploy
        </Button>
      </div>

      <ImportComposeDialog open={importOpen} onOpenChange={setImportOpen} onImport={state.replace} />
    </div>
  );
}
