import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { GithubIcon } from 'lucide-react';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TextSkeleton } from '@/components/states';
import { GitManifestPreview } from './git-manifest-preview';
import { goToProvider } from './git-nav';
import { GITHUB_WEB, hostOf } from './git-providers';
import { rememberGitReturn, type GitReturn } from './git-return';
import { useDebouncedValue } from './use-debounced-value';

const isHttp = (u: string): boolean => /^https?:\/\/[^\s/]+/.test(u);

interface GitConnectGithubProps {
  /** `github`: github.com only · `self`: a GitHub Enterprise host is required · absent: either (the /ci panel). */
  host?: 'github' | 'self';
  returnTo?: GitReturn['to'];
}

/**
 * GitHub, one click. First time on a host: register this controller's own
 * GitHub App from a manifest (previewed first). After that: install it on the
 * accounts and repos you want to deploy.
 */
export function GitConnectGithub({ host, returnTo }: GitConnectGithubProps): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [ghes, setGhes] = React.useState('');
  const typed = useDebouncedValue(ghes.trim().replace(/\/+$/, ''), 400);
  const custom = isHttp(typed) && typed !== GITHUB_WEB ? typed : undefined;
  const webBase = host === 'github' ? GITHUB_WEB : (custom ?? (host === 'self' ? null : GITHUB_WEB));
  const wb = webBase && webBase !== GITHUB_WEB ? { webBase } : undefined;

  // Keep the previous answer while a new host resolves, so the field isn't swapped for a skeleton mid-typing.
  const app = useQuery({
    ...trpc.gitConnections.githubApp.queryOptions(wb),
    enabled: webBase !== null,
    placeholderData: (prev) => prev,
  });
  const conns = useQuery(trpc.gitConnections.list.queryOptions());
  const installs = (conns.data ?? []).filter((c) => c.kind === 'github' && c.baseUrl.replace(/\/+$/, '') === webBase).length;
  const install = useMutation(
    trpc.gitConnections.githubInstallLink.mutationOptions({
      onSuccess: ({ url }) => {
        rememberGitReturn(returnTo ? { to: returnTo } : null);
        goToProvider(url, navigate);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const hostField =
    host === 'github' ? (
      <span className="font-mono text-[12.5px]">github.com</span>
    ) : (
      <Input
        value={ghes}
        onChange={(e) => setGhes(e.target.value)}
        placeholder={host === 'self' ? 'https://github.example.com' : 'github.com, or your GitHub Enterprise URL'}
        aria-label="GitHub host"
        className="h-8 max-w-xs font-mono text-[12.5px]"
      />
    );

  if (webBase === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">Where’s your GitHub Enterprise server? We create a private GitHub App on it in one click.</p>
        {hostField}
      </div>
    );
  }
  if (app.isPending) return <TextSkeleton className="h-4 w-2/3" />;
  if (!app.data?.registered) return <GitManifestPreview webBase={webBase} hostField={hostField} returnTo={returnTo} />;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {installs === 0 ? 'Installed nowhere yet. ' : `Installed on ${installs} account${installs === 1 ? '' : 's'}. `}
        This controller’s GitHub App <span className="font-mono">{app.data.name ?? app.data.slug}</span> is ready on{' '}
        {hostOf(webBase)} — install it on the account or repos you want to deploy.
      </p>
      {host === 'github' ? null : hostField}
      <Button className="w-fit pointer-coarse:min-h-11" onClick={() => install.mutate(wb)} disabled={install.isPending}>
        <GithubIcon className="size-4" /> {install.isPending ? 'Opening GitHub…' : `Install on ${hostOf(webBase)} ↗`}
      </Button>
    </div>
  );
}
