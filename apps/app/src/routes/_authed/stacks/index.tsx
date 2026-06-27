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
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';

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

function StacksPage(): React.JSX.Element {
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

  const list = stacks.data ?? [];
  const total = list.length;
  const running = list.filter((s) => s.status === 'running').length;
  const allRunning = total > 0 && running === total;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Stacks"
        title={
          total === 0 ? (
            <>Ship a whole app at <em>once</em>.</>
          ) : allRunning ? (
            <>All <em>{running}</em> stacks running.</>
          ) : (
            <><em>{running}</em> of {total} stacks running.</>
          )
        }
        description="Deploy multi-service apps straight from a compose file."
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
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <EmptyState
              icon={<LayersIcon />}
              title="Nothing shipped yet."
              description="Paste a compose file and deploy every service in one move — they show up here as they converge."
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={running} /> / {total} running
              </span>
              <span className="mono-label text-muted-foreground">{total} total</span>
            </div>
            <div className="divide-border divide-y border-t">
              {list.map((stack) => (
                <div
                  key={stack.id}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <StatusBadge
                    tone={stack.status === 'running' ? 'online' : stack.status === 'failed' ? 'offline' : 'progress'}
                    label=""
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{stack.name}</p>
                    <p className="text-muted-foreground mono-label truncate">{stack.status}</p>
                  </div>
                  <div className="hidden w-32 text-right sm:block">
                    <p className="mono-data text-sm">{stack.serviceCount}</p>
                    <p className="text-muted-foreground mono-label">services</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove.mutate({ id: stack.id })}
                    disabled={remove.isPending}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
