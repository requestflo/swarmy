import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { connectionsFor, initialProvider, type GitProviderId } from './git-providers';
import { canListRepos, type GitConnection, type LinkRepoRequest, type ProviderRepo } from './git-types';

/**
 * What the git wizard has picked so far: provider card → account → repo (or a
 * typed URL) → branch → folder. Everything else is derived. The provider and
 * account default to the connection just made (`initialConnectionId`), else
 * the first card with a connection.
 */
export function useGitWizard(initialConnectionId?: string) {
  const trpc = useTRPC();
  const list = useQuery(trpc.gitConnections.list.queryOptions());
  const conns: GitConnection[] = list.data ?? [];
  const [picked, setPicked] = React.useState<GitProviderId | null>(null);
  const [accountId, setAccountId] = React.useState<string | null>(initialConnectionId ?? null);
  const [repo, setRepo] = React.useState<ProviderRepo | null>(null);
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [configPath, setConfigPath] = React.useState('');
  const [deployKey, setDeployKey] = React.useState(false);

  const provider = picked ?? initialProvider(conns, initialConnectionId);
  const accounts = connectionsFor(provider, conns);
  // "Any git URL" works without signing in; every other card needs an account.
  const conn = accounts.find((c) => c.id === accountId) ?? (provider === 'url' ? null : (accounts[0] ?? null));
  const connected = provider === 'url' || conn !== null;
  const picking = conn ? canListRepos(conn.kind) : false;
  const cloneUrl = picking ? (repo?.cloneUrl ?? '') : url.trim();
  const source = connected && cloneUrl && branch.trim() ? { connectionId: conn?.id, cloneUrl, ref: branch.trim() } : null;

  const reset = (): void => {
    setRepo(null);
    setBranch('main');
    setConfigPath('');
  };
  const pickProvider = (p: GitProviderId): void => {
    setPicked(p);
    setAccountId(null);
    reset();
  };
  const pickAccount = (id: string | null): void => {
    setAccountId(id);
    reset();
  };
  const pickRepo = (r: ProviderRepo): void => {
    setRepo(r);
    setBranch(r.defaultBranch);
    setConfigPath('');
  };
  const linkRequest = (): LinkRepoRequest => ({
    connectionId: conn?.id,
    ...(picking && repo ? { repo: { id: repo.id, fullName: repo.fullName, cloneUrl: repo.cloneUrl } } : { url: cloneUrl }),
    branch: branch.trim(),
    configPath: configPath.trim() || undefined,
    deployKey: !picking && deployKey ? true : undefined,
  });

  return {
    list, conns, provider, accounts, conn, connected, picking, repo, url, branch, configPath, deployKey, source,
    /** owner/name of what's picked, for headings. */
    repoName: repo?.fullName ?? (url.trim().replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/') || null),
    pickProvider, pickAccount, pickRepo, setUrl, setBranch, setConfigPath, setDeployKey, linkRequest,
  };
}

export type GitWizard = ReturnType<typeof useGitWizard>;
