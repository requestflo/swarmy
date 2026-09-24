import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { RevealedCredential } from './credential-reveal';
import { useEmailMutationHandlers } from './use-email';

interface Props {
  domains: string[];
  apiUrl: string;
  onCreated: (c: RevealedCredential) => void;
}

/** Make a credential by hand: name, allowed domains, bounce/complaint webhook. */
export function CreateCredentialDialog({ domains, apiUrl, onCreated }: Props): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [allowed, setAllowed] = React.useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = React.useState('');
  const handlers = useEmailMutationHandlers('Credential created');
  const create = useMutation(
    trpc.email.createCredential.mutationOptions({
      ...handlers,
      onSuccess: (r) => {
        handlers.onSuccess();
        onCreated({ smtpHost: r.smtp.host, smtpPort: r.smtp.port, username: r.smtp.username, password: r.smtp.password, apiKey: r.apiKey, apiUrl, webhookSecret: r.webhookSecret });
        setOpen(false);
        setName('');
        setWebhookUrl('');
        setAllowed([]);
      },
    }),
  );
  const toggle = (d: string) => setAllowed((a) => (a.includes(d) ? a.filter((x) => x !== d) : [...a, d]));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <PlusIcon className="size-4" /> New credential
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New sending credential</DialogTitle>
          <DialogDescription>An SMTP login and an HTTP API key for one app or tool.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, domains: allowed, webhookUrl: webhookUrl || null });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="cred-name">Name</Label>
            <Input id="cred-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="newsletter" required />
          </div>
          <div className="space-y-1">
            <Label>May send from</Label>
            <div className="flex flex-wrap gap-2">
              {domains.length === 0 ? <p className="text-muted-foreground text-xs">Any verified domain (add domains to narrow it).</p> : null}
              {domains.map((d) => (
                <button key={d} type="button" onClick={() => toggle(d)} className={`rounded-full border px-3 py-1 text-xs ${allowed.includes(d) ? 'border-primary bg-primary/10' : 'border-border'}`}>
                  {d}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">None selected = every verified domain.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cred-hook">Bounce & complaint webhook (optional)</Label>
            <Input id="cred-hook" type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://app.example.com/hooks/email" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !name}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
