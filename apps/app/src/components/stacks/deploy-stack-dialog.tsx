import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const EXAMPLE = `services:
  web:
    image: nginx:latest
    deploy:
      replicas: 2
    ports:
      - "8080:80"
`;

/** Coral CTA + compose dialog. Owns the deployFromCompose mutation. */
export function DeployStackDialog(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
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

  return (
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
            <Label htmlFor="stack-name" className="mono-label">
              Name
            </Label>
            <Input
              id="stack-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="compose" className="mono-label">
              compose.yml
            </Label>
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
  );
}
