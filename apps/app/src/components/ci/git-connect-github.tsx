import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { GithubIcon } from 'lucide-react';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TextSkeleton } from '@/components/states';
import { goToProvider, postGithubManifest } from './git-nav';

/**
 * GitHub, one click. First time: register swarmy's GitHub App from a manifest
 * (optionally under a GitHub org). After that: install it on repos/accounts.
 */
export function GitConnectGithub(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const app = useQuery(trpc.gitConnections.githubApp.queryOptions());
  const [org, setOrg] = React.useState('');

  const start = useMutation(
    trpc.gitConnections.startGithubManifest.mutationOptions({
      onSuccess: ({ postUrl, manifest }) => postGithubManifest(postUrl, manifest, navigate),
      onError: (e) => toast.error(e.message),
    }),
  );
  const install = useMutation(
    trpc.gitConnections.githubInstallLink.mutationOptions({
      onSuccess: ({ url }) => goToProvider(url, navigate),
      onError: (e) => toast.error(e.message),
    }),
  );

  if (app.isPending) return <TextSkeleton className="h-4 w-2/3" />;

  if (app.data?.registered) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          swarmy’s GitHub App <span className="mono-data">{app.data.name ?? app.data.slug}</span> is
          ready. Install it on the account or repos you want to deploy.
        </p>
        <Button onClick={() => install.mutate(undefined)} disabled={install.isPending}>
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
      <div className="grid max-w-sm gap-1.5">
        <Label className="mono-label">GitHub org (optional)</Label>
        <Input
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          placeholder="Leave blank for your account"
        />
      </div>
      <Button
        onClick={() => start.mutate(org.trim() ? { githubOrg: org.trim() } : undefined)}
        disabled={start.isPending}
      >
        <GithubIcon className="size-4" /> {start.isPending ? 'Opening GitHub…' : 'Connect GitHub'}
      </Button>
    </div>
  );
}
