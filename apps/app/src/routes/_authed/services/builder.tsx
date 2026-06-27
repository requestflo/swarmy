import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { DownloadIcon, EyeIcon, FileInputIcon, Loader2Icon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { ServiceBuilder } from '@/components/service-builder/service-builder';
import { ImportComposeDialog } from '@/components/service-builder/import-compose-dialog';
import { PreviewDialog } from '@/components/service-builder/preview-dialog';
import { useServiceModel } from '@/components/service-builder/use-service-model';

export const Route = createFileRoute('/_authed/services/builder')({
  component: ServiceBuilderPage,
});

function ServiceBuilderPage(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const state = useServiceModel();
  const [importOpen, setImportOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  // Full-fidelity deploy: the COMPLETE ServiceModel (placement, mounts, labels,
  // healthcheck, resources, configs/secrets) is projected through the builder
  // router, not the lossy CreateServiceInput subset.
  const deploy = useMutation(
    trpc.builder.deploy.mutationOptions({
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
              onClick={() => setPreviewOpen(true)}
              disabled={state.hasBlockingError}
            >
              <EyeIcon className="size-4" /> Preview
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => exportCompose.mutate({ models: [state.model] })}
              disabled={state.hasBlockingError}
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
          disabled={deploy.isPending || state.hasBlockingError}
          onClick={() => deploy.mutate({ model: state.model })}
        >
          {deploy.isPending && <Loader2Icon className="animate-spin" />}
          Deploy
        </Button>
      </div>

      <ImportComposeDialog open={importOpen} onOpenChange={setImportOpen} onImport={state.replace} />
      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} model={state.model} />
    </div>
  );
}
