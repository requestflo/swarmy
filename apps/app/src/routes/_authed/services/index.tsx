import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BoxesIcon, PlusIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@swarmy/ui';
import { SERVICE_STATUS_TONE } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';

export const Route = createFileRoute('/_authed/services/')({
  component: ServicesPage,
});

function ServicesPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const services = useQuery({ ...trpc.services.list.queryOptions({}), refetchInterval: 3_000 });

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
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const count = services.data?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Services"
        title={
          count > 0 ? (
            <>
              <CountUp value={count} /> service{count === 1 ? '' : 's'} <em>running</em>.
            </>
          ) : (
            <>Deploy a <em>service</em>.</>
          )
        }
        description="Long-running workloads deployed across the swarm."
        actions={
          <Button onClick={() => navigate({ to: '/services/new' })}>
            <PlusIcon className="size-4" /> New service
          </Button>
        }
      />
      {services.data && services.data.length === 0 ? (
        <EmptyState
          icon={<BoxesIcon />}
          title="Nothing deployed yet"
          description="Quiet so far. Ship your first service to the swarm."
          action={
            <Button onClick={() => navigate({ to: '/services/new' })}>
              <PlusIcon className="size-4" /> New service
            </Button>
          }
        />
      ) : (
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="mono-label">Name</TableHead>
                  <TableHead className="mono-label">Image</TableHead>
                  <TableHead className="mono-label">Status</TableHead>
                  <TableHead className="mono-label">Replicas</TableHead>
                  <TableHead className="mono-label">Ingress</TableHead>
                  <TableHead className="mono-label text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(services.data ?? []).map((svc) => (
                  <TableRow key={svc.id} className="hover:bg-accent/60 transition-colors">
                    <TableCell>
                      <Link
                        to="/services/$serviceId"
                        params={{ serviceId: svc.id }}
                        className="font-medium hover:underline"
                      >
                        {svc.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground mono-data text-xs">
                      {svc.image}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={SERVICE_STATUS_TONE[svc.status] ?? 'neutral'} label={svc.status} />
                    </TableCell>
                    <TableCell className="mono-data">
                      {svc.replicas.running} / {svc.replicas.desired}
                    </TableCell>
                    <TableCell>
                      {svc.ingressEnabled ? <Badge variant="success">on</Badge> : <Badge variant="muted">off</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Restart"
                        onClick={() => restart.mutate({ id: svc.id })}
                      >
                        <RotateCwIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove"
                        onClick={() => remove.mutate({ id: svc.id })}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
