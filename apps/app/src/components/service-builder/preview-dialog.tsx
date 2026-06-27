import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@swarmy/ui';
import type { ServiceModelOut } from '@swarmy/core/compose';
import { useTRPC, useTRPCClient } from '@/integrations/trpc';

interface PreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ServiceModelOut;
}

/** "View as compose / docker service create" — the unopinionated escape hatch. */
export function PreviewDialog({ open, onOpenChange, model }: PreviewDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const [compose, setCompose] = React.useState('');
  const [spec, setSpec] = React.useState('');

  const exportCompose = useMutation(
    trpc.builder.exportCompose.mutationOptions({
      onSuccess: (res) => setCompose(res.yaml),
      onError: (e) => toast.error(e.message),
    }),
  );

  React.useEffect(() => {
    if (!open) return;
    exportCompose.mutate({ models: [model] });
    client.builder.exportServiceSpec
      .query({ model })
      .then((res) => setSpec(JSON.stringify(res.spec, null, 2)))
      .catch((e: Error) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text);
    toast.success('Copied');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>
            The exact artifact swarmy would apply — runs on vanilla Docker Swarm.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="compose">
          <TabsList>
            <TabsTrigger value="compose">compose.yaml</TabsTrigger>
            <TabsTrigger value="spec">ServiceSpec (JSON)</TabsTrigger>
          </TabsList>
          <TabsContent value="compose" className="grid gap-2">
            <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs">{compose || '…'}</pre>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => copy(compose)}>
                Copy
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="spec" className="grid gap-2">
            <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs">{spec || '…'}</pre>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => copy(spec)}>
                Copy
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
