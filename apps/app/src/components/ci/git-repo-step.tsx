import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth } from '@/components/calm';
import { GitBranchField } from './git-branch-field';
import { GitConnectGeneric } from './git-connect-generic';
import { goToProvider } from './git-nav';
import { GitRepoPicker } from './git-repo-picker';
import { accountLabel } from './git-providers';
import { rememberGitReturn, type GitReturn } from './git-return';
import { GitUrlFields } from './git-url-fields';
import type { GitWizard } from './use-git-wizard';

const NONE = '__none__';

/** Org/account picker → repo list (or a typed URL) → branch: "Pushes to main deploy". */
export function GitRepoStep({
  w,
  apps,
  returnTo,
}: {
  w: GitWizard;
  apps: (cloneUrl: string) => string[];
  returnTo?: GitReturn['to'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const install = useMutation(
    trpc.gitConnections.githubInstallLink.mutationOptions({
      onSuccess: ({ url }) => {
        rememberGitReturn(returnTo ? { to: returnTo } : null);
        goToProvider(url, navigate);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const conn = w.conn;
  const accountIds = w.provider === 'url' ? [NONE, ...w.accounts.map((c) => c.id)] : w.accounts.map((c) => c.id);
  const labelOf = (id: string): string => {
    const c = w.accounts.find((a) => a.id === id);
    return c ? accountLabel(c) : 'No sign-in (public or SSH)';
  };

  return (
    <section aria-label="Repo and branch" className="calm-card flex min-w-0 flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        {accountIds.length > 1 ? (
          <Select value={conn?.id ?? NONE} onValueChange={(v) => w.pickAccount(v === NONE ? null : v)}>
            <SelectTrigger aria-label="Account" className="h-9 w-auto min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accountIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {labelOf(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : conn ? (
          <span className="font-mono text-[12.5px]">{accountLabel(conn)}</span>
        ) : null}
        {conn?.kind === 'github' ? (
          <Button variant="ghost" size="sm" className="ml-auto pointer-coarse:min-h-11" disabled={install.isPending}
            onClick={() => install.mutate(w.provider === 'self' ? { webBase: conn.baseUrl.replace(/\/+$/, '') } : undefined)}>
            Add an account ↗
          </Button>
        ) : null}
      </div>
      {w.picking && conn ? (
        <>
          <GitRepoPicker connectionId={conn.id} value={w.repo} onChange={w.pickRepo} apps={apps} />
          {w.repo ? (
            <div className="border-border flex flex-col gap-1.5 border-t pt-3">
              <span className="calm-eyebrow">Branch</span>
              <GitBranchField conn={conn} repo={w.repo} value={w.branch} onChange={w.setBranch} />
              <span className="text-muted-foreground text-[12.5px]">
                Pushes to <span className="text-foreground font-mono">{w.branch || '…'}</span> deploy · pull requests get previews once swarmy.yaml turns them on
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <GitUrlFields url={w.url} onUrlChange={w.setUrl} branch={w.branch} onBranchChange={w.setBranch} deployKey={w.deployKey} onDeployKeyChange={w.setDeployKey} />
          {w.provider === 'url' ? (
            <Depth at="controls">
              <div className="border-border flex flex-col gap-2 border-t pt-3">
                <span className="calm-eyebrow">Private repo over HTTPS? Sign in to its host</span>
                <GitConnectGeneric onConnected={() => void w.list.refetch()} />
              </div>
            </Depth>
          ) : null}
        </>
      )}
    </section>
  );
}
