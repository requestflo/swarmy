import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileTextIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, EmptyState } from '@/components/states';
import { TemplateDialog, type TemplateDraft } from './template-dialog';
import { useEmailMutationHandlers } from './use-email';

/** Stored templates for the send API (`template: "welcome"`, `{{ var }}` placeholders). */
export function TemplatesCard(): React.JSX.Element {
  const trpc = useTRPC();
  const [editing, setEditing] = React.useState<TemplateDraft | null>(null);
  const list = useQuery(trpc.email.templates.queryOptions());
  const remove = useMutation(trpc.email.removeTemplate.mutationOptions(useEmailMutationHandlers('Template removed')));
  return (
    <div className="card-pop p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Templates</p>
          <p className="text-muted-foreground text-xs">
            Send with <code className="mono-data">{'{ "template": "welcome", "variables": { "name": "Ada" } }'}</code>. HTML values are escaped; use{' '}
            <code className="mono-data">{'{{{ raw }}}'}</code> for trusted HTML.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing({ name: '', subject: '', html: '', text: '' })}>
          New template
        </Button>
      </div>
      {list.isPending ? (
        <div className="mt-4">
          <CardSkeleton />
        </div>
      ) : !list.data || list.data.length === 0 ? (
        <EmptyState icon={<FileTextIcon />} title="No templates yet — write one." description="Keep subjects and bodies here so apps only send a name and a few variables." />
      ) : (
        <div className="border-border divide-border mt-4 divide-y rounded-xl border">
          {list.data.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-2">
              <div className="min-w-0 flex-1">
                <p className="mono-data text-sm">{t.name}</p>
                <p className="text-muted-foreground truncate text-xs">{t.subject}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditing({ name: t.name, subject: t.subject, html: t.html ?? '', text: t.text ?? '' })}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" className="text-status-offline" onClick={() => remove.mutate({ id: t.id })}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      {editing ? <TemplateDialog draft={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
