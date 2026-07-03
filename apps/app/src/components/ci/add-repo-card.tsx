import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface AddRepoCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/** Inline expanding card (no modal): link a git repo. */
export function AddRepoCard({ open, onOpenChange, onDone }: AddRepoCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const [provider, setProvider] = React.useState<'github' | 'gitlab'>('github');
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [token, setToken] = React.useState('');
  const [autodeploy, setAutodeploy] = React.useState(false);

  const add = useMutation(
    trpc.cicd.addRepo.mutationOptions({
      onSuccess: () => {
        toast.success('Repo linked');
        setUrl('');
        setToken('');
        onOpenChange(false);
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="space-y-3 border-b px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="mono-label">Provider</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as 'github' | 'gitlab')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="gitlab">GitLab</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Branch</Label>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Repository URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              className="mono-data"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Access token (encrypted at rest)</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… / glpat-…"
            />
          </div>
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <Label className="font-medium">Autodeploy on build</Label>
            <Switch checked={autodeploy} onCheckedChange={setAutodeploy} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => add.mutate({ provider, url, branch, token: token || undefined, autodeploy })}
              disabled={add.isPending || !url}
            >
              {add.isPending ? 'Linking…' : 'Link repo'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
