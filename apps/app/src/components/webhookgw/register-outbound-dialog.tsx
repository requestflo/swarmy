import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  type ButtonProps,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Register an outbound endpoint (admin). The signing secret (`whsec_…`) is
 * revealed exactly once here — swarmy stores it encrypted and never returns it.
 */
export function RegisterOutboundDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState('');
  const [events, setEvents] = React.useState('*');
  const [secret, setSecret] = React.useState<string | null>(null);

  const register = useMutation(
    trpc.webhooksOut.register.mutationOptions({
      onSuccess: (e) => {
        setSecret(e.secret);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setUrl('');
      setEvents('*');
      setSecret(null);
    }
  };

  const eventList = events.split(',').map((s) => s.trim()).filter(Boolean);
  const ready = /^https?:\/\/.+/.test(url) && eventList.length > 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant} size="sm">
          <PlusIcon className="size-4" /> Register endpoint
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? 'Save your signing secret' : 'Register an outbound endpoint'}</DialogTitle>
          <DialogDescription>
            {secret
              ? 'This is shown once. Verify deliveries by checking the X-Swarmy-Signature header (HMAC-SHA256 of the raw body).'
              : 'swarmy will POST subscribed events to this URL, signed so you can verify them.'}
          </DialogDescription>
        </DialogHeader>

        {secret ? (
          <div className="bg-muted flex items-center gap-2 rounded-lg p-3">
            <code className="mono-data min-w-0 flex-1 break-all text-xs">{secret}</code>
            <CopyButton value={secret} />
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">URL</Label>
              <Input value={url} placeholder="https://ops.example.com/hooks/swarmy" onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Events (comma-separated, * for all)</Label>
              <Input value={events} placeholder="*" onChange={(e) => setEvents(e.target.value)} />
            </div>
          </div>
        )}

        <DialogFooter>
          {secret ? (
            <Button onClick={() => close(false)}>Done — secret saved</Button>
          ) : (
            <Button
              disabled={!ready || register.isPending}
              onClick={() => register.mutate({ url: url.trim(), events: eventList })}
            >
              {register.isPending ? 'Registering…' : 'Register'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
