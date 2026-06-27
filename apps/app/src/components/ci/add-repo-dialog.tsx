import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

interface AddRepoDialogProps {
  onDone: () => void;
}

/** Coral CTA + dialog to link a git repo. Mirrors the original mutation exactly. */
export function AddRepoDialog({ onDone }: AddRepoDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [provider, setProvider] = React.useState<'github' | 'gitlab'>('github');
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [token, setToken] = React.useState('');
  const [autodeploy, setAutodeploy] = React.useState(false);

  const add = useMutation(
    trpc.cicd.addRepo.mutationOptions({
      onSuccess: () => {
        toast.success('Repo linked');
        setOpen(false);
        setUrl('');
        setToken('');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="size-4" /> Link a repo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link a repository</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
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
            <Label className="mono-label">Repository URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Branch</Label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
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
        </div>
        <DialogFooter>
          <Button
            onClick={() => add.mutate({ provider, url, branch, token: token || undefined, autodeploy })}
            disabled={add.isPending || !url}
          >
            Link repo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
