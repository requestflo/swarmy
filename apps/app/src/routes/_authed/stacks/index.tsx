import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayersIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Input,
  Label,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/stacks/')({
  component: StacksPage,
});

const EXAMPLE = `services:
  web:
    image: nginx:latest
    deploy:
      replicas: 2
    ports:
      - "8080:80"
`;

function StacksPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 4_000 });
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [compose, setCompose] = React.useState(EXAMPLE);

  const deploy = useMutation(
    trpc.stacks.deployFromCompose.mutationOptions({
      onSuccess: () => {
        toast.success('Stack deploying');
        setOpen(false);
        setName('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.stacks.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Stack removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div>
      <PageHeader
        title="Stacks"
        description="Deploy multi-service apps from a compose file."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <PlusIcon className="size-4" /> Deploy stack
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Deploy stack</DialogTitle>
                <DialogDescription>Paste a docker-compose definition.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="stack-name">Name</Label>
                  <Input id="stack-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="compose">compose.yml</Label>
                  <Textarea
                    id="compose"
                    className="h-64 font-mono text-xs"
                    value={compose}
                    onChange={(e) => setCompose(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => deploy.mutate({ name, composeSource: compose })}
                  disabled={deploy.isPending || !name}
                >
                  Deploy
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />
      {stacks.data && stacks.data.length === 0 ? (
        <EmptyState icon={<LayersIcon />} title="No stacks" description="Deploy a compose file to get started." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Services</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(stacks.data ?? []).map((stack) => (
                  <TableRow key={stack.id}>
                    <TableCell className="font-medium">{stack.name}</TableCell>
                    <TableCell>{stack.serviceCount}</TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={stack.status === 'running' ? 'online' : stack.status === 'failed' ? 'offline' : 'progress'}
                        label={stack.status}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => remove.mutate({ id: stack.id })}>
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
