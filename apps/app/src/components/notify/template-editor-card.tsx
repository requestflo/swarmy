import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotifyTemplateView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, Input, Label, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TestSendRow } from './test-send-row';

interface TemplateEditorCardProps {
  open: boolean;
  /** null = creating a new template. */
  template: NotifyTemplateView | null;
  onClose: () => void;
}

/** Inline editor section that swaps in below the templates list (no modal). */
export function TemplateEditorCard({
  open,
  template,
  onClose,
}: TemplateEditorCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [bodyText, setBodyText] = React.useState('');
  const [bodyHtml, setBodyHtml] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setSubject(template?.subject ?? '');
    setBodyText(template?.bodyText ?? '');
    setBodyHtml(template?.bodyHtml ?? '');
  }, [open, template]);

  const save = useMutation(
    trpc.notifications.saveTemplate.mutationOptions({
      onSuccess: (t) => {
        toast.success(`Template ${t.name} saved.`);
        onClose();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const ready = Boolean(name.trim() && subject.trim() && (bodyText.trim() || bodyHtml.trim()));

  return (
    <Collapsible open={open}>
      <CollapsibleContent>
        <div className="border-border bg-card mt-4 space-y-4 rounded-xl border p-5">
          <div>
            <p className="text-sm font-bold">{template ? `Edit ${template.name}` : 'New template'}</p>
            <p className="text-muted-foreground text-xs">
              Use <code>{'{{name}}'}</code> placeholders anywhere — senders pass values as{' '}
              <code>vars</code>. HTML body values are escaped automatically.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="mono-label">Name</Label>
              <Input
                placeholder="alert-fired"
                className="mono-data"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Subject</Label>
              <Input
                placeholder="Alert: {{signal}} on {{resource}}"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Text body</Label>
            <Textarea
              rows={4}
              className="mono-data"
              placeholder={'{{signal}} fired on {{resource}}.\n\n{{message}}'}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">HTML body (optional)</Label>
            <Textarea
              rows={4}
              className="mono-data"
              placeholder={'<h2>{{signal}}</h2>\n<p>{{message}}</p>'}
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
            />
          </div>

          <TestSendRow />

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!ready || save.isPending}
              onClick={() =>
                save.mutate({
                  ...(template ? { id: template.id } : {}),
                  name: name.trim(),
                  subject: subject.trim(),
                  ...(bodyText.trim() ? { bodyText } : {}),
                  ...(bodyHtml.trim() ? { bodyHtml } : {}),
                })
              }
            >
              {save.isPending ? 'Saving…' : template ? 'Save changes' : 'Create template'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
