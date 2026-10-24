import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import { GiteaSetupHint, GiteaTestResultLine } from './git-gitea-hints';
import type { GiteaMode } from './git-gitea-model';
import type { GitReturn } from './git-return';
import { GitSegmented } from './git-segmented';
import { useGiteaConnect } from './use-gitea-connect';

interface GitConnectGiteaProps {
  onConnected: () => void;
  /** Where the OAuth round trip comes back to (the Deploy wizard); absent = /ci. */
  returnTo?: GitReturn['to'];
}

const OPTIONS: ReadonlyArray<{ value: GiteaMode; label: string }> = [
  { value: 'token', label: 'Access token' },
  { value: 'oauth', label: 'Sign in with an OAuth app' },
];

/** Gitea or Forgejo (self-hosted, Codeberg): the server's address and a token, tested before it's saved. */
export function GitConnectGitea({ onConnected, returnTo }: GitConnectGiteaProps): React.JSX.Element {
  const g = useGiteaConnect(onConnected, returnTo);
  const { form, set } = g;
  return (
    <div className="space-y-3">
      <GitSegmented value={g.mode} onChange={g.setMode} options={OPTIONS} />
      <div className="grid gap-1.5">
        <Label htmlFor="gitea-url" className="mono-label">Server URL</Label>
        <Input
          id="gitea-url"
          value={form.baseUrl}
          onChange={(e) => set('baseUrl')(e.target.value)}
          placeholder="https://git.example.com"
          className="mono-data"
          inputMode="url"
        />
      </div>
      {g.mode === 'token' ? (
        <div className="grid gap-1.5">
          <Label htmlFor="gitea-token" className="mono-label">Access token (encrypted at rest)</Label>
          <Input id="gitea-token" type="password" autoComplete="off" value={form.token} onChange={(e) => set('token')(e.target.value)} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="gitea-client" className="mono-label">Client ID</Label>
            <Input id="gitea-client" value={form.clientId} onChange={(e) => set('clientId')(e.target.value)} className="mono-data" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gitea-secret" className="mono-label">Client secret</Label>
            <Input id="gitea-secret" type="password" autoComplete="off" value={form.clientSecret} onChange={(e) => set('clientSecret')(e.target.value)} />
          </div>
        </div>
      )}
      <GiteaSetupHint mode={g.mode} />
      {g.tested ? <GiteaTestResultLine result={g.tested} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="pointer-coarse:min-h-11"
          onClick={g.runTest}
          disabled={!/^https?:\/\//.test(form.baseUrl.trim()) || g.test.isPending}
        >
          {g.test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button className="pointer-coarse:min-h-11" onClick={g.submit} disabled={!g.ready || g.create.isPending}>
          {g.create.isPending ? 'Connecting…' : g.mode === 'oauth' ? 'Continue to sign in' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}
