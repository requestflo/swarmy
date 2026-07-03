import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import type { StatusPageView } from '@swarmy/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Collapsible,
  CollapsibleContent,
  Switch,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StatusPageInlineForm } from './status-page-inline-form';

interface StackStatusPageRowProps {
  page: StatusPageView;
  stack: string;
}

/**
 * One status page as a flat row: public URL + custom domain up front, live
 * switch, row-expand inline edit, and an AlertDialog-confirmed delete.
 */
export function StackStatusPageRow({ page, stack }: StackStatusPageRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);

  const setEnabled = useMutation(
    trpc.statusPages.setEnabled.mutationOptions({
      onSuccess: (p) => {
        toast.success(p.enabled ? `${p.title} is live` : `${p.title} is dark — /s/${p.slug} now 404s`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.statusPages.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`${page.title} deleted — /s/${page.slug} now 404s`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={editing} onOpenChange={setEditing} className="border-b last:border-b-0">
      <div className="hover:bg-accent/50 flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-4 transition-colors">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{page.title}</p>
          <p className="text-muted-foreground truncate text-xs">
            <a href={page.publicPath} target="_blank" rel="noreferrer" className="mono-data hover:text-primary hover:underline">
              {page.publicPath}
            </a>
            {page.domain ? (
              <>
                {' · '}
                <span className="mono-data">{page.domain}</span>
              </>
            ) : null}
            {' · '}
            {page.components.length} component{page.components.length === 1 ? '' : 's'}
          </p>
        </div>

        <a
          href={page.publicPath}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-semibold"
        >
          Open <ExternalLinkIcon className="size-3.5" />
        </a>

        <div className="flex items-center gap-1.5">
          <Switch
            checked={page.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={(enabled) => setEnabled.mutate({ id: page.id, enabled })}
            aria-label={page.enabled ? 'Take page dark' : 'Take page live'}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${page.title}`}
            className={cn(editing && 'bg-accent')}
            onClick={() => setEditing((v) => !v)}
          >
            <PencilIcon className="size-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="text-status-offline" aria-label={`Delete ${page.title}`}>
                <Trash2Icon className="size-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {page.title}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The public page at <span className="mono-data">/s/{page.slug}</span> stops
                  resolving and its uptime history is deleted. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate({ id: page.id })}>
                  Delete page
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <CollapsibleContent>
        <div className="bg-accent/30 border-t px-6 py-5">
          <StatusPageInlineForm
            stack={stack}
            page={page}
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
