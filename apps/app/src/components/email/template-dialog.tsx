import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useEmailMutationHandlers } from './use-email';

export interface TemplateDraft {
  name: string;
  subject: string;
  html: string;
  text: string;
}

/** Create or edit a template (name is the key the send API uses). */
export function TemplateDialog({ draft, onClose }: { draft: TemplateDraft; onClose: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const [t, setT] = React.useState(draft);
  const handlers = useEmailMutationHandlers('Template saved');
  const save = useMutation(
    trpc.email.saveTemplate.mutationOptions({
      ...handlers,
      onSuccess: () => {
        handlers.onSuccess();
        onClose();
      },
    }),
  );
  const set = (k: keyof TemplateDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setT({ ...t, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.name ? `Edit ${draft.name}` : 'New template'}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ name: t.name, subject: t.subject, html: t.html || null, text: t.text || null });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <div className="space-y-1">
              <Label htmlFor="tpl-name">Name</Label>
              <Input id="tpl-name" value={t.name} onChange={set('name')} placeholder="welcome" disabled={Boolean(draft.name)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input id="tpl-subject" value={t.subject} onChange={set('subject')} placeholder="Welcome, {{ name }}" required />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-html">HTML</Label>
            <Textarea id="tpl-html" className="mono-data min-h-40 text-xs" value={t.html} onChange={set('html')} placeholder="<p>Hi {{ name }}, thanks for signing up.</p>" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-text">Plain text (optional — made from the HTML when empty)</Label>
            <Textarea id="tpl-text" className="mono-data min-h-24 text-xs" value={t.text} onChange={set('text')} />
          </div>
          <DialogFooter>
            <Button variant="outline" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save template'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
