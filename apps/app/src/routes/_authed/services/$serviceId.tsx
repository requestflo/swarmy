import * as React from 'react';
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon, Trash2Icon } from 'lucide-react';
import { SERVICE_STATUS_TONE } from '@swarmy/core';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/services/$serviceId')({
  component: ServiceDetailPage,
});

function ServiceDetailPage() {
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

  return (
    <div>
      <PageHeader
        title={s?.name ?? 'Service'}
        description={s?.image}
        actions={
          <Button variant="outline" size="sm" onClick={() => restart.mutate({ id: serviceId })}>
            <RotateCwIcon className="size-4" /> Restart
          </Button>
        }
      />

      {deploy.data && deploy.data.phase !== 'complete' && deploy.data.phase !== 'failed' && (
        <Alert className="mb-4">
          <AlertTitle className="capitalize">Deploying — {deploy.data.phase}</AlertTitle>
          <AlertDescription>
            {deploy.data.ready ?? 0} / {deploy.data.desired ?? desired} replicas ready
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="danger">Danger</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">State</span>
                <StatusBadge tone={SERVICE_STATUS_TONE[s?.status ?? ''] ?? 'neutral'} label={s?.status ?? '—'} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Replicas</span>
                <span className="tabular-nums">
                  {s?.replicas.running ?? 0} / {s?.replicas.desired ?? 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Ingress</span>
                {s?.ingressEnabled ? <Badge variant="success">on</Badge> : <Badge variant="muted">off</Badge>}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Scale</CardTitle>
            </CardHeader>
            <CardContent className="flex items-end gap-2">
              <div className="grid flex-1 gap-1">
                <span className="text-muted-foreground text-xs">Desired replicas</span>
                <Input
                  type="number"
                  min={0}
                  value={desired}
                  onChange={(e) => setReplicas(Number(e.target.value))}
                />
              </div>
              <Button
                onClick={() => scale.mutate({ id: serviceId, replicas: desired })}
                disabled={scale.isPending}
              >
                Apply
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Environment & ports</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Environment</p>
                {Object.entries(s?.env ?? {}).length ? (
                  <pre className="bg-muted rounded-md p-3 font-mono text-xs">
                    {Object.entries(s?.env ?? {})
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n')}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">None</p>
                )}
              </div>
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Ports</p>
                {(s?.ports ?? []).length ? (
                  <div className="flex flex-wrap gap-2">
                    {(s?.ports ?? []).map((p, i) => (
                      <Badge key={i} variant="outline">
                        {p.published ? `${p.published}:` : ''}
                        {p.target}/{p.protocol}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">None</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <Card>
            <CardContent className="text-muted-foreground p-6 text-sm">
              Live logs stream from the node agent over the controller. Connect a node running this
              service to tail its output here.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="mt-4">
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive text-base">Danger zone</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <div className="text-sm">
                <p className="font-medium">Remove this service</p>
                <p className="text-muted-foreground">Stops all replicas and deletes the service.</p>
              </div>
              <Button variant="destructive" onClick={() => remove.mutate({ id: serviceId })}>
                <Trash2Icon className="size-4" /> Remove
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
