import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon, TerminalIcon } from 'lucide-react';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ServiceDeployBanner } from '@/components/services/service-deploy-banner';
import { ServiceOverviewPanel } from '@/components/services/service-overview-panel';
import { ServiceConfigPanel } from '@/components/services/service-config-panel';
import { ServiceLogsPanel } from '@/components/services/service-logs-panel';
import { ServiceDangerPanel } from '@/components/services/service-danger-panel';

export const Route = createFileRoute('/_authed/services/$serviceId')({
  component: ServiceDetailPage,
});

function ServiceDetailPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { serviceId } = useParams({ from: '/_authed/services/$serviceId' });

  const svc = useQuery({ ...trpc.services.get.queryOptions({ id: serviceId }), refetchInterval: 3_000 });
  const deploy = useQuery({
    ...trpc.services.deployStatus.queryOptions({ serviceId }),
    refetchInterval: 2_000,
  });
  const [replicas, setReplicas] = React.useState<number | null>(null);

  const scale = useMutation(
    trpc.services.scale.mutationOptions({
      onSuccess: () => {
        toast.success('Scaling');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const restart = useMutation(
    trpc.services.restart.mutationOptions({
      onSuccess: () => toast.success('Restart queued'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.services.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Service removed');
        void navigate({ to: '/services' });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const s = svc.data;
  const desired = replicas ?? s?.replicas.desired ?? 1;
  const deploying =
    deploy.data && deploy.data.phase !== 'complete' && deploy.data.phase !== 'failed';

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Service"
        title={
          <>
            <CountUp value={s?.replicas.running ?? 0} /> of {s?.replicas.desired ?? 0}{' '}
            <em>running</em>.
          </>
        }
        description={s ? `${s.name} · ${s.image}` : undefined}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full font-bold"
              onClick={() => restart.mutate({ id: serviceId })}
              disabled={restart.isPending}
            >
              <RotateCwIcon className="size-4" /> Restart
            </Button>
            <Button asChild size="sm">
              <Link to="/services/$serviceId/terminal" params={{ serviceId }}>
                <TerminalIcon className="size-4" /> Open terminal
              </Link>
            </Button>
          </>
        }
      />

      {deploying && deploy.data ? (
        <ServiceDeployBanner deploy={deploy.data} desired={desired} />
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="danger">Danger</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <ServiceOverviewPanel
            service={s}
            desired={desired}
            onDesiredChange={setReplicas}
            onScale={() => scale.mutate({ id: serviceId, replicas: desired })}
            scaling={scale.isPending}
          />
        </TabsContent>

        <TabsContent value="config">
          <ServiceConfigPanel service={s} />
        </TabsContent>

        <TabsContent value="logs">
          <ServiceLogsPanel serviceId={serviceId} />
        </TabsContent>

        <TabsContent value="danger">
          <ServiceDangerPanel
            onRemove={() => remove.mutate({ id: serviceId })}
            removing={remove.isPending}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
