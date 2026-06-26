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

  return (
    <div>
      <PageHeader
        title="Services"
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
          title="No services yet"
          description="Deploy your first service to the cluster."
          action={
            <Button onClick={() => navigate({ to: '/services/new' })}>
              <PlusIcon className="size-4" /> New service
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Replicas</TableHead>
                  <TableHead>Ingress</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(services.data ?? []).map((svc) => (
                  <TableRow key={svc.id}>
                    <TableCell>
                      <Link
                        to="/services/$serviceId"
                        params={{ serviceId: svc.id }}
                        className="font-medium hover:underline"
                      >
                        {svc.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {svc.image}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={SERVICE_STATUS_TONE[svc.status] ?? 'neutral'} label={svc.status} />
                    </TableCell>
                    <TableCell className="tabular-nums">
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
