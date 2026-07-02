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
import { StatusPageFields } from './status-page-fields';
import { EMPTY_DRAFT, draftFromPage, draftReady, type PageDraft } from './page-draft';

/**
 * Create/edit a status page: title, global-unique slug (`/s/<slug>`), the
 * component picker, optional custom domain and the two visibility toggles.
 */
export function StatusPageDialog({
  page,
  trigger,
}: {
  /** Present → edit mode; absent → create mode. */
  page?: StatusPageView;
  trigger: React.ReactNode;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<PageDraft>(EMPTY_DRAFT);

  const done = (verb: string, slug: string): void => {
    toast.success(`Status page ${verb} — it's live at /s/${slug}`);
    setOpen(false);
    void qc.invalidateQueries();
  };
  const create = useMutation(
    trpc.statusPages.create.mutationOptions({
      onSuccess: (p) => done('created', p.slug),
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.statusPages.update.mutationOptions({
      onSuccess: (p) => done('saved', p.slug),
      onError: (e) => toast.error(e.message),
    }),
  );

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) setDraft(page ? draftFromPage(page) : EMPTY_DRAFT);
  };

  const pending = create.isPending || update.isPending;
  const submit = (): void => {
    const common = {
      title: draft.title.trim(),
      components: draft.components,
      showUptime: draft.showUptime,
      showIncidents: draft.showIncidents,
    };
    if (page) {
      update.mutate({
        id: page.id,
        ...common,
        domain: draft.domain.trim() === '' ? null : draft.domain.trim(),
      });
    } else {
      create.mutate({
        ...common,
        slug: draft.slug,
        ...(draft.domain.trim() === '' ? {} : { domain: draft.domain.trim() }),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{page ? `Edit ${page.title}` : 'Create a status page'}</DialogTitle>
          <DialogDescription>
            {page
              ? 'Change what the page shows. The public URL stays put.'
              : 'Pick the components your users care about — you get a public page with live status, uptime bars and incident history.'}
          </DialogDescription>
        </DialogHeader>
        <StatusPageFields draft={draft} onChange={setDraft} slugLocked={Boolean(page)} />
        <DialogFooter>
          <Button onClick={submit} disabled={!draftReady(draft) || pending}>
            {pending ? 'Saving…' : page ? 'Save changes' : 'Create page'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
