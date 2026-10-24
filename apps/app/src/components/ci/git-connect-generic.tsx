import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface GitConnectGenericProps {
  onConnected: () => void;
}

/** Any git host over HTTPS (you type the repo URL later). Gitea / Forgejo has its own card. */
export function GitConnectGeneric({ onConnected }: GitConnectGenericProps): React.JSX.Element {
  const trpc = useTRPC();
  const [baseUrl, setBaseUrl] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [tokenUser, setTokenUser] = React.useState('');
  const [token, setToken] = React.useState('');

  const create = useMutation(
    trpc.gitConnections.create.mutationOptions({
      onSuccess: (res) => {
        toast.success(`${res.connection.displayName} is connected.`);
        onConnected();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void =>
    create.mutate({
      kind: 'generic',
      mode: 'basic',
      baseUrl: baseUrl.trim(),
      displayName: displayName.trim() || undefined,
      token: token || undefined,
      tokenUser: tokenUser.trim() || undefined,
    });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label className="mono-label">Host URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://git.example.com"
            className="mono-data"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Name (optional)</Label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Company git"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Username (optional)</Label>
          <Input value={tokenUser} onChange={(e) => setTokenUser(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Token (optional, encrypted)</Label>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Public repos need no token. SSH remotes get a deploy key when you link them.
      </p>
      <Button onClick={submit} disabled={!/^https?:\/\//.test(baseUrl.trim()) || create.isPending}>
        {create.isPending ? 'Connecting…' : 'Connect'}
      </Button>
    </div>
  );
}
