import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileTextIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { NotifyTemplateView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TemplateEditorDialog } from './template-editor-dialog';

/** Reusable email templates — list, edit, delete, create. */
export function TemplatesCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const templates = useQuery(trpc.notifications.listTemplates.queryOptions());
  const [editing, setEditing] = React.useState<NotifyTemplateView | null>(null);
  const [creating, setCreating] = React.useState(false);

  const remove = useMutation(
    trpc.notifications.removeTemplate.mutationOptions({
      onSuccess: () => {
        toast.success('Template deleted.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = templates.data ?? [];

  return (
    <section className="card-pop p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">Templates</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Reusable subject + body with <code className="text-xs">{'{{var}}'}</code> placeholders
            — call them by name from alerts or <code className="text-xs">/api/v1/notify</code>.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" /> New
        </Button>
      </div>

      <div className="mt-4">
        {templates.isLoading ? (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="shimmer-line h-10 rounded-lg" />
            ))}
          </div>
        ) : templates.isError ? (
          <div className="text-muted-foreground flex items-center justify-between gap-3 text-sm">
            <span>Couldn't load templates — {templates.error.message}</span>
            <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-3 rounded-xl border border-dashed p-4 text-sm">
            <FileTextIcon className="size-4 shrink-0" />
            No templates yet — create one and reuse it everywhere swarmy sends mail.
          </div>
        ) : (
          <div className="divide-border border-border divide-y rounded-xl border">
            {rows.map((t) => (
              <div key={t.id} className="hover:bg-accent/50 flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="mono-data truncate text-sm font-semibold">{t.name}</div>
                  <div className="text-muted-foreground truncate text-xs">{t.subject}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${t.name}`}
                  onClick={() => setEditing(t)}
                >
                  <PencilIcon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${t.name}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ id: t.id })}
                >
                  <Trash2Icon className="text-status-offline size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <TemplateEditorDialog
        open={creating || editing !== null}
        template={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </section>
  );
}
