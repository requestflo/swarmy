import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import type { ChannelConfigInput, NotificationChannelKindView } from '@swarmy/core';
import { NOTIFICATION_CHANNEL_KINDS } from '@swarmy/core';
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
  Input,
  Label,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const KIND_LABEL: Record<NotificationChannelKindView, string> = {
  email: 'Email',
  slack: 'Slack',
  teams: 'Teams',
  webhook: 'Webhook',
};

/** Add a notification channel: email address, or a slack/teams/webhook URL. */
export function AddChannelDialog({ variant = 'default' }: { variant?: ButtonProps['variant'] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<NotificationChannelKindView>('email');
  const [to, setTo] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [secret, setSecret] = React.useState('');

  const reset = (): void => {
    setName('');
    setKind('email');
    setTo('');
    setUrl('');
    setSecret('');
  };
  const create = useMutation(
    trpc.alerts.createChannel.mutationOptions({
      onSuccess: (c) => {
        toast.success(`Channel ${c.name} added — send it a test.`);
        setOpen(false);
        reset();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const config: ChannelConfigInput | null =
    kind === 'email'
      ? to.trim()
        ? { kind, to: to.trim() }
        : null
      : url.trim()
        ? kind === 'webhook'
          ? { kind, url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) }
          : { kind, url: url.trim() }
        : null;
  const ready = Boolean(name.trim() && config);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> Add channel
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a notification channel</DialogTitle>
          <DialogDescription>
            Where should swarmy reach you when an alert fires? The destination is encrypted and
            never shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ch-name">Name</Label>
            <Input
              id="ch-name"
              placeholder="On-call email"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Kind</Label>
            <div className="flex flex-wrap gap-2">
              {NOTIFICATION_CHANNEL_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                    kind === k
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          {kind === 'email' ? (
            <div className="space-y-2">
              <Label htmlFor="ch-to">Email address</Label>
              <Input
                id="ch-to"
                type="email"
                placeholder="oncall@yourteam.dev"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="ch-url">
                {kind === 'webhook' ? 'Webhook URL' : `${KIND_LABEL[kind]} incoming-webhook URL`}
              </Label>
              <Input
                id="ch-url"
                placeholder="https://…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}
          {kind === 'webhook' ? (
            <div className="space-y-2">
              <Label htmlFor="ch-secret">HMAC secret (optional)</Label>
              <Input
                id="ch-secret"
                type="password"
                placeholder="min 8 characters — signs X-Swarmy-Signature"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={!ready || create.isPending}
            onClick={() => config && create.mutate({ name: name.trim(), config })}
          >
            {create.isPending ? 'Adding…' : 'Add channel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
