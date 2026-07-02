import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { SECRET_NAME_TEMPLATES } from '@swarmy/core';
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
import { SecretValueField } from './secret-value-field';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Create a secret family (v1). Template chips prefill common NAMES only —
 * the value is always yours (pasted or generated) and is write-only.
 */
export function CreateSecretDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [family, setFamily] = React.useState('');
  const [value, setValue] = React.useState('');

  const create = useMutation(
    trpc.secrets.create.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Secret ${r.family} created (v${r.version})`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setFamily('');
      setValue('');
    }
  };

  const ready = NAME_RE.test(family.trim()) && family.trim().length <= 56 && value.length > 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New secret
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a secret</DialogTitle>
          <DialogDescription>
            Stored as a Docker secret on your swarm — versioned, rotatable, and mounted into
            services at <code className="mono-data">/run/secrets/&lt;name&gt;</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1.5">
            {SECRET_NAME_TEMPLATES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFamily(t)}
                className={cn(
                  'mono-data rounded-full border border-border px-2.5 py-1 text-[11px] transition-colors',
                  family === t
                    ? 'bg-primary/10 border-primary/40 text-primary font-semibold'
                    : 'hover:bg-accent text-muted-foreground',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Name</Label>
            <Input
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              placeholder="DATABASE_URL"
              className="mono-data"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <SecretValueField value={value} onChange={setValue} />
        </div>
        <DialogFooter>
          <Button onClick={() => create.mutate({ family: family.trim(), value })} disabled={!ready || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create secret'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
