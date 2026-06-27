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
import { CountUp } from '@/components/count-up';

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
          <Button
            variant="outline"
            size="sm"
            onClick={() => restart.mutate({ id: serviceId })}
            disabled={restart.isPending}
          >
            <RotateCwIcon className="size-4" /> Restart
          </Button>
        }
      />

      {deploying && (
        <Alert className="card-pop mb-6 border-0">
          <AlertTitle className="flex items-center gap-2 capitalize">
            <span className="pulse-dot" /> Deploying — {deploy.data?.phase}
          </AlertTitle>
          <AlertDescription>
            <span className="mono-data">
              {deploy.data?.ready ?? 0} / {deploy.data?.desired ?? desired}
            </span>{' '}
            replicas ready
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

        <TabsContent value="overview" className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <Row label="State">
                <StatusBadge
                  tone={SERVICE_STATUS_TONE[s?.status ?? ''] ?? 'neutral'}
                  label={s?.status ?? '—'}
                />
              </Row>
              <Row label="Replicas">
                <span className="mono-data">
                  {s?.replicas.running ?? 0} / {s?.replicas.desired ?? 0}
                </span>
              </Row>
              <Row label="Ingress">
                {s?.ingressEnabled ? (
                  <Badge variant="success">on</Badge>
                ) : (
                  <Badge variant="muted">off</Badge>
                )}
              </Row>
            </CardContent>
          </Card>

          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Scale</CardTitle>
            </CardHeader>
            <CardContent className="flex items-end gap-2">
              <div className="grid flex-1 gap-1">
                <span className="mono-label text-muted-foreground">Desired replicas</span>
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

        <TabsContent value="config" className="mt-6">
          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Environment & ports</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <div>
                <p className="mono-label text-muted-foreground mb-2">Environment</p>
                {Object.entries(s?.env ?? {}).length ? (
                  <pre className="bg-muted rounded-xl p-3 font-mono text-xs">
                    {Object.entries(s?.env ?? {})
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n')}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">Nothing set. This service runs clean.</p>
                )}
              </div>
              <div>
                <p className="mono-label text-muted-foreground mb-2">Ports</p>
                {(s?.ports ?? []).length ? (
                  <div className="flex flex-wrap gap-2">
                    {(s?.ports ?? []).map((p, i) => (
                      <Badge key={i} variant="outline" className="mono-data">
                        {p.published ? `${p.published}:` : ''}
                        {p.target}/{p.protocol}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No ports published.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="mt-6">
          <Card className="card-pop border-0">
            <CardContent className="text-muted-foreground p-10 text-center text-sm">
              No logs yet. Live output streams from the node agent over the controller — connect a
              node running this service to tail it here.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="mt-6">
          <Card className="card-pop border-destructive/40 border">
            <CardHeader>
              <CardTitle className="text-destructive text-base">Danger zone</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div className="text-sm">
                <p className="font-medium">Remove this service</p>
                <p className="text-muted-foreground">
                  Stops every replica and deletes the service. No undo.
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={() => remove.mutate({ id: serviceId })}
                disabled={remove.isPending}
              >
                <Trash2Icon className="size-4" /> Remove
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="mono-label text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
