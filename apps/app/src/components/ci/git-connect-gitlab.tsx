import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { GitSegmented } from './git-segmented';
import { goToProvider } from './git-nav';

interface GitConnectGitlabProps {
  onConnected: () => void;
}

type Mode = 'oauth' | 'token';

const OPTIONS = [
  { value: 'oauth', label: 'Sign in with GitLab' },
  { value: 'token', label: 'Access token' },
] as const;

/** GitLab (cloud or self-managed): an OAuth application, or a personal/group access token. */
export function GitConnectGitlab({ onConnected }: GitConnectGitlabProps): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [mode, setMode] = React.useState<Mode>('oauth');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [token, setToken] = React.useState('');

  const create = useMutation(
    trpc.gitConnections.create.mutationOptions({
      onSuccess: (res) => {
        if (res.authorizeUrl) return goToProvider(res.authorizeUrl, navigate);
        toast.success(
          `GitLab is connected${res.connection.account ? ` as ${res.connection.account}` : ''}.`,
        );
        onConnected();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const base = baseUrl.trim() || undefined;
  const ready = mode === 'oauth' ? clientId && clientSecret : token.length >= 8;
  const submit = (): void =>
    mode === 'oauth'
      ? create.mutate({ kind: 'gitlab', mode, baseUrl: base, clientId, clientSecret })
      : create.mutate({ kind: 'gitlab', mode, baseUrl: base, token });

  return (
    <div className="space-y-3">
      <GitSegmented value={mode} onChange={setMode} options={OPTIONS} />
      <div className="grid gap-1.5">
        <Label className="mono-label">GitLab URL (blank for gitlab.com)</Label>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://gitlab.example.com"
          className="mono-data"
        />
      </div>
      {mode === 'oauth' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="mono-label">Application ID</Label>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="mono-data"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Secret</Label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-1.5">
          <Label className="mono-label">Token with api scope (encrypted at rest)</Label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="glpat-…"
          />
        </div>
      )}
      <Button onClick={submit} disabled={!ready || create.isPending}>
        {create.isPending
          ? 'Connecting…'
          : mode === 'oauth'
            ? 'Continue to GitLab'
            : 'Connect GitLab'}
      </Button>
    </div>
  );
}
