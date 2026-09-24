import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { GithubIcon } from 'lucide-react';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TextSkeleton } from '@/components/states';
import { goToProvider, postGithubManifest } from './git-nav';
import { useDebouncedValue } from './use-debounced-value';

const GITHUB_WEB = 'https://github.com';
const isHttp = (u: string): boolean => /^https?:\/\/[^\s/]+/.test(u);

/**
 * GitHub, one click. First time: register swarmy's GitHub App from a manifest
 * (optionally under a GitHub org, optionally on GitHub Enterprise Server).
 * After that: install it on repos/accounts.
 */
export function GitConnectGithub(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [org, setOrg] = React.useState('');
  const [ghes, setGhes] = React.useState('');
  const typed = useDebouncedValue(ghes.trim().replace(/\/+$/, ''), 400);
  const webBase = isHttp(typed) && typed !== GITHUB_WEB ? typed : undefined;
  const wb = webBase ? { webBase } : undefined;

  // Keep the previous answer while a new GHES URL resolves, so the field isn't swapped for a skeleton mid-typing.
  const app = useQuery({
    ...trpc.gitConnections.githubApp.queryOptions(wb),
    placeholderData: (prev) => prev,
  });
  const conns = useQuery(trpc.gitConnections.list.queryOptions());
  const installs = (conns.data ?? []).filter(
    (c) =>
      c.kind === 'github' && c.baseUrl.replace(/\/+$/, '') === (app.data?.webBase ?? GITHUB_WEB),
  ).length;

  const onError = (e: { message: string }): void => void toast.error(e.message);
  const start = useMutation(
    trpc.gitConnections.startGithubManifest.mutationOptions({
      onSuccess: ({ postUrl, manifest }) => postGithubManifest(postUrl, manifest, navigate),
      onError,
    }),
  );
  const install = useMutation(
    trpc.gitConnections.githubInstallLink.mutationOptions({
      onSuccess: ({ url }) => goToProvider(url, navigate),
      onError,
    }),
  );

  const ghesField = (
    <div className="grid max-w-sm gap-1.5">
      <Label className="mono-label">GitHub Enterprise Server URL (optional)</Label>
      <Input
        value={ghes}
        onChange={(e) => setGhes(e.target.value)}
        placeholder="https://github.corp.example"
        className="mono-data"
      />
    </div>
  );

  if (app.isPending) return <TextSkeleton className="h-4 w-2/3" />;

  if (app.data?.registered) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          {installs === 0
            ? 'Installed nowhere yet. '
            : `Installed on ${installs} account${installs === 1 ? '' : 's'}. `}
          swarmy’s GitHub App <span className="mono-data">{app.data.name ?? app.data.slug}</span> is
          ready — install it on the account or repos you want to deploy.
        </p>
        {ghesField}
        <Button onClick={() => install.mutate(wb)} disabled={install.isPending}>
          <GithubIcon className="size-4" />{' '}
          {install.isPending ? 'Opening GitHub…' : 'Install on GitHub'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        We’ll create a private GitHub App for this controller. You approve it on GitHub, pick the
        repos, and come straight back here.
      </p>
      <div className="flex flex-wrap gap-3">
        <div className="grid max-w-sm flex-1 gap-1.5">
          <Label className="mono-label">GitHub org (optional)</Label>
          <Input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="Leave blank for your account"
          />
        </div>
        {ghesField}
      </div>
      <Button
        onClick={() => start.mutate({ ...(org.trim() ? { githubOrg: org.trim() } : {}), ...wb })}
        disabled={start.isPending || (ghes.trim() !== '' && !isHttp(ghes.trim()))}
      >
        <GithubIcon className="size-4" /> {start.isPending ? 'Opening GitHub…' : 'Connect GitHub'}
      </Button>
    </div>
  );
}
