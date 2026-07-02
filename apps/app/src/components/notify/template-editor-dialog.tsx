import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotifyTemplateView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Create/edit one template: name, subject, text + html bodies, vars help. */
export function TemplateEditorDialog({
  open,
  template,
  onClose,
}: {
  open: boolean;
  /** null = creating a new template. */
  template: NotifyTemplateView | null;
  onClose: () => void;
}): React.JSX.Element {
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
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.name}` : 'New template'}</DialogTitle>
          <DialogDescription>
            Use <code>{'{{name}}'}</code> placeholders anywhere — senders pass values as{' '}
            <code>vars</code>. In the HTML body, values are escaped automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                placeholder="alert-fired"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input
                id="tpl-subject"
                placeholder="Alert: {{signal}} on {{resource}}"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-text">Text body</Label>
            <Textarea
              id="tpl-text"
              rows={4}
              placeholder={'{{signal}} fired on {{resource}}.\n\n{{message}}'}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-html">HTML body (optional)</Label>
            <Textarea
              id="tpl-html"
              rows={4}
              placeholder={'<h2>{{signal}}</h2>\n<p>{{message}}</p>'}
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
