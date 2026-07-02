import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  type ButtonProps,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EMPTY_ENDPOINT_DRAFT, EndpointFields, type EndpointDraft } from './endpoint-fields';

/**
 * Create-endpoint dialog: name + slug, verification scheme (+ shared secret,
 * stored encrypted, never shown again) and the queue/forward target.
 */
export function CreateEndpointDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<EndpointDraft>(EMPTY_ENDPOINT_DRAFT);

  const create = useMutation(
    trpc.inboundWebhooks.createEndpoint.mutationOptions({
      onSuccess: (e) => {
        toast.success(`Endpoint live — paste ${e.url} into the provider`);
        setOpen(false);
        setDraft(EMPTY_ENDPOINT_DRAFT);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) setDraft(EMPTY_ENDPOINT_DRAFT);
  };

  const targetReady =
    draft.targetKind === 'forward'
      ? /^https?:\/\/.+/.test(draft.url)
      : Boolean(draft.cacheCluster && draft.queue.trim());
  const ready = Boolean(
    draft.name.trim() &&
      draft.slug &&
      targetReady &&
      (draft.verifyKind === 'none' || draft.secret.length >= 8),
  );

  const submit = (): void => {
    create.mutate({
      name: draft.name.trim(),
      slug: draft.slug,
      verifyKind: draft.verifyKind,
      ...(draft.verifyKind !== 'none' ? { secret: draft.secret } : {}),
      target:
        draft.targetKind === 'forward'
          ? { kind: 'forward', url: draft.url.trim() }
          : {
              kind: 'queue',
              cacheCluster: draft.cacheCluster,
              queue: draft.queue.trim(),
              convention: draft.convention,
            },
      retentionDays: draft.retentionDays,
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New endpoint
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create an inbound endpoint</DialogTitle>
          <DialogDescription>
            You get a public URL to paste into the provider. swarmy verifies every payload, keeps
            the history, and delivers it to your queue or service — retrying on failure.
          </DialogDescription>
        </DialogHeader>
        <EndpointFields draft={draft} onChange={setDraft} />
        <DialogFooter>
          <Button onClick={submit} disabled={!ready || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create endpoint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
