import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { CONFIG_NAME_TEMPLATES } from '@swarmy/core';
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
  Textarea,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

/** Create a config family (v1): name, mount path and the content itself. */
export function CreateConfigDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [family, setFamily] = React.useState('');
  const [mountPath, setMountPath] = React.useState('');
  const [content, setContent] = React.useState('');

  const create = useMutation(
    trpc.configs.create.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Config ${r.family} created (v${r.version}) — mounts at ${r.mountPath}`);
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
      setMountPath('');
      setContent('');
    }
  };

  const pathOk = mountPath.trim() === '' || PATH_RE.test(mountPath.trim());
  const ready =
    NAME_RE.test(family.trim()) && family.trim().length <= 56 && content.length > 0 && pathOk;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New config
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a config</DialogTitle>
          <DialogDescription>
            Stored as a versioned Docker config on your swarm and mounted into services at a stable
            path — future edits become new versions you diff, apply and roll back.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1.5">
            {CONFIG_NAME_TEMPLATES.map((t) => (
              <button
                key={t.family}
                type="button"
                onClick={() => {
                  setFamily(t.family);
                  setMountPath(t.mountPath);
                }}
                className={cn(
                  'mono-data rounded-full border border-border px-2.5 py-1 text-[11px] transition-colors',
                  family === t.family
                    ? 'bg-primary/10 border-primary/40 text-primary font-semibold'
                    : 'hover:bg-accent text-muted-foreground',
                )}
              >
                {t.family}
              </button>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Name</Label>
            <Input
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              placeholder="app-config"
              className="mono-data"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Mount path (optional)</Label>
            <Input
              value={mountPath}
              onChange={(e) => setMountPath(e.target.value)}
              placeholder={family.trim() ? `/${family.trim()}` : '/etc/app/config.yaml'}
              className="mono-data"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              Where consumers read the file. Stays stable across every version.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Content</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={'# paste your config here'}
              className="mono-data min-h-40 whitespace-pre"
              spellCheck={false}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              create.mutate({
                family: family.trim(),
                content,
                ...(mountPath.trim() ? { mountPath: mountPath.trim() } : {}),
              })
            }
            disabled={!ready || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create config'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
