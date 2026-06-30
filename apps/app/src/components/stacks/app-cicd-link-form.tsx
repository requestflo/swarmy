import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranchIcon } from 'lucide-react';
import {
  Button,
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

interface AppCicdLinkFormProps {
  serviceId: string;
}

type Provider = 'github' | 'gitlab';

/** Compact "link a git repo to this service" form (provider, url, branch, autodeploy). */
export function AppCicdLinkForm({ serviceId }: AppCicdLinkFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [provider, setProvider] = React.useState<Provider>('github');
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [token, setToken] = React.useState('');
  const [autodeploy, setAutodeploy] = React.useState(true);

  const add = useMutation(
    trpc.cicd.addRepo.mutationOptions({
      onSuccess: () => {
        toast.success('Repo linked');
        setUrl('');
        setToken('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    if (!url.trim()) return;
    add.mutate({
      provider,
      url: url.trim(),
      branch: branch.trim() || 'main',
      token: token.trim() || undefined,
      autodeploy,
      serviceId,
    });
  };

  return (
    <div className="border-border space-y-3 rounded-xl border p-3">
      <p className="text-muted-foreground text-xs">
        Link a repo so a push builds an image on your nodes, then deploys it here.
      </p>
      <div className="flex gap-2">
        <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="gitlab">GitLab</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={url}
          placeholder="github.com/acme/api"
          spellCheck={false}
          className="mono-data flex-1"
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label className="mono-label">Branch</Label>
          <Input
            value={branch}
            className="mono-data w-32"
            spellCheck={false}
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>
        <div className="flex-1 space-y-1">
          <Label className="mono-label">Token (private)</Label>
          <Input
            value={token}
            type="password"
            placeholder="optional"
            className="mono-data"
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs font-medium">
        <Switch checked={autodeploy} onCheckedChange={setAutodeploy} />
        Autodeploy this service on a successful build
      </label>
      <Button className="w-full" disabled={add.isPending || !url.trim()} onClick={submit}>
        <GitBranchIcon className="size-4" /> Link repo
      </Button>
    </div>
  );
}
