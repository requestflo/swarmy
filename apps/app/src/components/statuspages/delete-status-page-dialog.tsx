import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StatusPageView } from '@swarmy/core';
import {
  Button,
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

/** Danger confirm: deleting a page kills its public URL and uptime history. */
export function DeleteStatusPageDialog({
  page,
  trigger,
}: {
  page: StatusPageView;
  trigger: React.ReactNode;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const remove = useMutation(
    trpc.statusPages.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`${page.title} deleted — /s/${page.slug} now 404s`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {page.title}?</DialogTitle>
          <DialogDescription>
            The public page at <span className="mono-data">/s/{page.slug}</span> stops resolving
            and its uptime history is deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Keep it
          </Button>
          <Button
            variant="outline"
            className="border-status-offline text-status-offline hover:bg-status-offline/10"
            onClick={() => remove.mutate({ id: page.id })}
            disabled={remove.isPending}
          >
            {remove.isPending ? 'Deleting…' : 'Delete page'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
