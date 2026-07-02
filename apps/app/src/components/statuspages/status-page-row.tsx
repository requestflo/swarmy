import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import type { StatusPageView } from '@swarmy/core';
import { Button, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StatusPageDialog } from './status-page-dialog';
import { DeleteStatusPageDialog } from './delete-status-page-dialog';

/** One page: title, public link, component count, domain, live toggle, actions. */
export function StatusPageRow({ page }: { page: StatusPageView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const setEnabled = useMutation(
    trpc.statusPages.setEnabled.mutationOptions({
      onSuccess: (p) => {
        toast.success(p.enabled ? `${p.title} is live` : `${p.title} is dark — /s/${p.slug} now 404s`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="border-border hover:bg-accent/50 flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{page.title}</p>
        <p className="text-muted-foreground truncate text-xs">
          <span className="mono-data">{page.publicPath}</span>
          {page.domain ? (
            <>
              {' · '}
              <span className="mono-data">{page.domain}</span>
            </>
          ) : null}
        </p>
      </div>

      <span className="mono-data text-muted-foreground hidden text-xs sm:block">
        {page.components.length} component{page.components.length === 1 ? '' : 's'}
      </span>

      <a
        href={page.publicPath}
        target="_blank"
        rel="noreferrer"
        className="text-primary inline-flex items-center gap-1 text-xs font-bold hover:underline"
      >
        Preview <ExternalLinkIcon className="size-3.5" />
      </a>

      <div className="flex items-center gap-1.5">
        <Switch
          checked={page.enabled}
          disabled={setEnabled.isPending}
          onCheckedChange={(enabled) => setEnabled.mutate({ id: page.id, enabled })}
          aria-label={page.enabled ? 'Take page dark' : 'Take page live'}
        />
        <StatusPageDialog
          page={page}
          trigger={
            <Button variant="ghost" size="icon" aria-label={`Edit ${page.title}`}>
              <PencilIcon className="size-4" />
            </Button>
          }
        />
        <DeleteStatusPageDialog
          page={page}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="text-status-offline"
              aria-label={`Delete ${page.title}`}
            >
              <Trash2Icon className="size-4" />
            </Button>
          }
        />
      </div>
    </div>
  );
}
